import { globalHeaders, InternalError } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    DynamoDBClient,
    ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.region
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
        const allowedStatus = ["pending", "expired", "completed", "all"];
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
                console.log("data?.offerId*******", data?.offerId);

                // Parse stringified JSON fields
                ["detail", "fare", "financialInfo", "request"].forEach((field) => {
                    if (typeof data[field] === "string") {
                        try {
                            data[field] = JSON.parse(data[field]);
                        } catch { }
                    }
                });

                // 3️⃣ Fetch flightDetails from LOG_TRACE_TABLE where status = 10 and userId
                const scanCmd = new ScanCommand({
                    TableName: process.env.LOG_TRACE_TABLE,
                    FilterExpression: "#oid = :offerId",
                    ExpressionAttributeNames: {
                        "#oid": "offerId",
                    },
                    ExpressionAttributeValues: {
                        ":offerId": { S: data.offerId },
                    },
                });
                const logResult = await dynamo.send(scanCmd);
                const logItems = logResult.Items ?? [];
                console.log("logItems*******", logItems, "data?.offerId*******", data?.offerId);

                // 4️⃣ Parse and add flightDetails
                data.flightDetails = logItems.map((logItem) => {
                    const logData = unmarshall(logItem);
                    ["request"].forEach((field) => {
                        if (typeof logData[field] === "string") {
                            try {
                                logData[field] = JSON.parse(logData[field]);
                            } catch { }
                        }
                    });
                    // parse any JSON string fields if needed
                    return logData;
                });

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
        return await InternalError(error)
    }
};
