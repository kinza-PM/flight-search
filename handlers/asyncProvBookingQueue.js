import { v4 as uuidv4 } from "uuid";
import { getSessionId, globalHeaders, InternalError, logTrace, removedConverationId } from "../helper/helper.js";
import {
    DynamoDBClient,
    PutItemCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
const region = process.env.REGION
const dynamo = new DynamoDBClient({ region: region });
const sqsClient = new SQSClient({
    region: region,
});


export const handler = async (event) => {
    try {
        const response = {}

        for (const record of event.Records) {
            const { data, userId, userType, searchKey, marketingAirline, bookingPayload, offerId } = JSON.parse(record.body);
          
            response['data'] = typeof data === "string" ? JSON.parse(data) : data;

            const provBookingObj = {
                offerId: response?.data?.data[0]?.offerId,
                priceChanged: response?.data?.data[0]?.priceChanged,
                oldFare: response?.data?.data[0]?.oldFare,
                newFare: response?.data?.data[0]?.newFare,
                detail: JSON.stringify(response?.data?.data[0]?.detail),
                financialInfo: JSON.stringify(response?.data?.data[0]?.financialInfo),
                fare: JSON.stringify(response?.data?.data[0]?.fare),
                userId: userId,
                userType: userType,
                request: bookingPayload,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }

            // 2️⃣ Insert into DynamoDB
            const putCmd = new PutItemCommand({
                TableName: process.env.PROV_BOOKING_TABLE,
                Item: {
                    offerId: { S: provBookingObj.offerId },                 // PK
                    createdAt: { S: provBookingObj.createdAt },             // SK

                    priceChanged: { BOOL: provBookingObj.priceChanged },
                    oldFare: { N: String(provBookingObj.oldFare) },
                    newFare: { N: String(provBookingObj.newFare) },

                    detail: { S: provBookingObj.detail },
                    financialInfo: { S: provBookingObj.financialInfo },
                    fare: { S: provBookingObj.fare },

                    userId: { S: provBookingObj.userId },
                    userType: { S: provBookingObj.userType },

                    request: { S: provBookingObj.request },
                    isValid: { BOOL: false },
                    status: { S: "pending" },
                    updatedAt: { S: provBookingObj.updatedAt },
                },
            });

            await dynamo.send(putCmd);

            // Send SQS message for the UPDATE EXPIRED BOOKING 
            await sqsClient.send(
                new SendMessageCommand({
                    QueueUrl: process.env.UPDATE_EXIRED_BOOKING,
                    DelaySeconds: 300, // 5 minutes
                    MessageBody: JSON.stringify({
                        offerId: provBookingObj.offerId,
                        createdAt: provBookingObj.createdAt
                    })
                })
            );

            const payload = {
                id: uuidv4(),
                userId: userId,
                userType: userType,
                request: provBookingObj.request,
                response: JSON.stringify(data),
                offerId: provBookingObj.offerId,
                searchKey: searchKey,
                stepCode: 40,
                status: "active"
            };

            await logTrace(payload)
            // Success response
            console.log("response.data?.data[0].offerId*******", response.data?.data[0].offerId);

            const updateOfferIdInLogTrace = new UpdateItemCommand({
                TableName: process.env.LOG_TRACE_TABLE,
                Key: {
                    id: { S: searchKey }, // PK
                },
                UpdateExpression: "SET offerId = :f, selectedFlightCode = :sfc",
                ConditionExpression: "attribute_exists(id)",
                ExpressionAttributeValues: {
                    ":f": { S: response.data?.data[0].offerId },
                    ":sfc": { S: marketingAirline },
                }
            });

            await dynamo.send(updateOfferIdInLogTrace);

            const updateOfferIdInFareRules = new UpdateItemCommand({
                TableName: process.env.FLIGHT_FARE_RULES,
                Key: {
                    searchKey: { S: searchKey },
                    offerId: { S: offerId }
                },
                UpdateExpression: "SET SupplierOfferId = :soi, userId = :uId, userType = :uT",
                ConditionExpression: "attribute_exists(searchKey) AND attribute_exists(offerId)",
                ExpressionAttributeValues: {
                    ":soi": { S: response?.data?.data?.[0]?.offerId || "" },
                    ":uId": { S: userId },
                    ":uT": { S: userType }
                }
            });

            await dynamo.send(updateOfferIdInFareRules);

        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            // body: JSON.stringify(response.data),
        };
    } catch (error) {
        console.error("Record failed", {
            error: error.message,
            stack: error.stack,
        });

        return await InternalError(error)
    }
};
