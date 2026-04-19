import { globalHeaders, InternalError } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    GetItemCommand
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.REGION
const dynamo = new DynamoDBClient({ region: region });
export const handler = async (event) => {
    try {
        const authVerification = await verifyToken(event);
        console.log(JSON.stringify(authVerification, null, 2));
        if (authVerification?.principalId === "unknown") {
            return {
                ...globalHeaders(),
                statusCode: 401,
                body: JSON.stringify({
                    message: "Unauthorized: Invalid or expired token",
                }),
            };
        }

        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
        const allowedStatus = ["pending", "expired", "completed", "all","cancelled"];
        const { status } = body;

        if (!status) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "Missing required field: status" }),
            };
        }

        if (!allowedStatus.includes(status)) {
            return {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Credentials": true,
                },
                statusCode: 400,
                body: JSON.stringify({
                    message: `Invalid status. Allowed values are: ${allowedStatus.join(", ")}`
                }),
            };
        }

        let filterExpression = "#uid = :userId";
        let expressionAttributeNames = {
            "#uid": "userId",
        };
        let expressionAttributeValues = {
            ":userId": { S: authVerification?.context?.sub },
        };

        if (status && status !== "all") {
            filterExpression += " AND #st = :status";
            expressionAttributeNames["#st"] = "status";
            expressionAttributeValues[":status"] = { S: status };
        }

        const scanCmd = new ScanCommand({
            TableName: process.env.PROV_BOOKING_TABLE,
            FilterExpression: filterExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
        });

        const result = await dynamo.send(scanCmd);

        // Safety check
        const items = result.Items ?? [];

        const parsedItems = await Promise.all(
            items.map(async (item) => {
                const data = unmarshall(item);

                // Parse stringified JSON fields
                ["detail", "fare", "financialInfo", "request"].forEach((field) => {
                    if (typeof data[field] === "string") {
                        try {
                            data[field] = JSON.parse(data[field]);
                        } catch { }
                    }
                });

                // 3️⃣ Fetch flightDetails from LOG_TRACE_TABLE where status = 10 and userId
               
                const logTraceDetails = new QueryCommand({
                    TableName: process.env.LOG_TRACE_TABLE,
                    IndexName: "GSI_Offer_Step",
                    KeyConditionExpression: "offerId = :offerId AND stepCode = :stepCode",
                    ExpressionAttributeValues: {
                        ":offerId": { S: data.offerId },
                        ":stepCode": { N: "40" }
                    },
                    Limit: 1
                });

                const logResult = await dynamo.send(logTraceDetails);
              
                const logItems = logResult.Items
                    ? logResult.Items.map(item => unmarshall(item))
                    : [];
              
                const logItem = logItems[0];

                if (!logItem) {
                    console.warn("No log item found for offerId", data?.offerId);
                    return;
                }

                const fareRulesDetails = new QueryCommand({
                    TableName: process.env.FLIGHT_FARE_RULES,
                    IndexName: "GSI_OfferId_Supplier",
                    KeyConditionExpression: "SupplierOfferId = :soi AND searchKey = :s",
                    ExpressionAttributeValues: {
                        ":soi": { S: logItem.offerId },
                        ":s": { S: logItem.searchKey },
                    },
                    Limit: 1,
                });

                const fareRuleResult = await dynamo.send(fareRulesDetails);

                // ✅ get first item only
                const fareRuleItem = fareRuleResult.Items?.length
                    ? unmarshall(fareRuleResult.Items[0])
                    : null;

                // ✅ parse JSON fields
                if (fareRuleItem) {
                    ["fareRules", "miniFareRules", "bookingRules"].forEach((field) => {
                        if (typeof fareRuleItem[field] === "string") {
                            try {
                                fareRuleItem[field] = JSON.parse(fareRuleItem[field]);
                            } catch { }
                        }
                    });
                }

                data.fareRulesDetails = fareRuleItem;


                return data;
            })
        );

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify({
                count: result.Count,
                items: parsedItems,
            }),
        };
    } catch (error) {
        console.error("Record failed", {
            error: error.message,
            stack: error.stack,
        });
        return await InternalError(error)
    }
};
