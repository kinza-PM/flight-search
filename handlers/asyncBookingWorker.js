import axios from "axios";
import { getSessionId, globalHeaders, InternalError, removedConverationId } from "../helper/helper.js";
import {
    DynamoDBClient,
    PutItemCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
const region = process.env.REGION
const dynamo = new DynamoDBClient({ region: region });

export const handler = async (event) => {
    try {
        const MAIN_ENDPOINT = process.env.MAIN_ENDPOINT
        for (const record of event.Records) {
            const { fetchUrl, offerId, sessionId, conversationId, requestBody, userId, userType } = JSON.parse(record.body);

            let finalData = null;
            let attempts = 0;
            const url = `${MAIN_ENDPOINT}${fetchUrl}`

            while (attempts < 10) {
                const res = await axios.get(url, {
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-KEY": process.env.X_API_KEY,
                        sessionId,
                        conversationId
                    }
                });
                console.log("res.data******", JSON.stringify(res.data, null, 2));

                if (res.data?.meta?.success === true && res.data?.data?.length > 0) {
                    finalData = res.data;
                    break;
                }

                await new Promise(r => setTimeout(r, 3000));
                attempts++;
            }

            if (!finalData) {
                throw new Error("Booking not available after retries, skipping...");
            }


            console.log("finalData******", JSON.stringify(finalData, null, 2));
            const bookingObj = {
                bookingStatus: finalData?.data[0]?.bookingStatus,
                priceChanged: finalData?.data[0]?.priceChanged,
                bookingReferenceId: finalData?.data[0]?.bookingReferenceId,
                financialInfo: JSON.stringify(finalData?.data[0]?.financialInfo),
                passengers: JSON.stringify(finalData?.data[0]?.passengers),
                fare: JSON.stringify(finalData?.data[0]?.fare),
                ticketDocument: JSON.stringify(finalData?.data[0].ticketDocument),
                request: JSON.stringify(requestBody),
                userId: userId,
                userType: userType,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }

            console.log("bookingObj********", bookingObj);

            if (!bookingObj?.bookingReferenceId) {
                throw new Error("bookingReferenceId is missing from provider response");
            }

            const putCmd = new PutItemCommand({
                TableName: process.env.FLIGHT_BOOKING_TABLE,
                Item: {
                    // 🔑 Keys
                    bookingReferenceId: { S: bookingObj.bookingReferenceId },  // PK
                    createdAt: { S: bookingObj.createdAt },                    // SK

                    // Attributes
                    bookingStatus: { S: bookingObj.bookingStatus },
                    priceChanged: { BOOL: bookingObj.priceChanged },
                    supplierLocator: { S: bookingObj.supplierLocator || "" },

                    financialInfo: { S: bookingObj.financialInfo },
                    passengers: { S: bookingObj.passengers },
                    fare: { S: bookingObj.fare },
                    ticketDocument: { S: bookingObj.ticketDocument },

                    request: { S: bookingObj.request },

                    userId: { S: bookingObj.userId },
                    userType: { S: bookingObj.userType },

                    status: { S: "active" },
                    updatedAt: { S: bookingObj.updatedAt }
                }
            });

            await dynamo.send(putCmd);

            console.log("bookingObj.bookingReferenceId*************", bookingObj.bookingReferenceId);

            const updateProvBooking = new UpdateItemCommand({
                TableName: process.env.PROV_BOOKING_TABLE,
                Key: {
                    offerId: { S: offerId },   // PK
                },
                UpdateExpression: "SET isValid = :v, #st = :s, bookingReferenceId = :bfi",
                ExpressionAttributeNames: {
                    "#st": "status"          // status is a reserved word → alias required
                },
                ExpressionAttributeValues: {
                    ":v": { BOOL: false },   // expired → not valid
                    ":s": { S: "completed" },
                    ":bfi": { S: bookingObj.bookingReferenceId }
                }
            });

            await dynamo.send(updateProvBooking);
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            // body: JSON.stringify(response.data),
        };
    } catch (error) {
        console.log("error*********", error);

        return await InternalError(error)
    }
};
