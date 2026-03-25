import { globalHeaders, InternalError } from "../helper/helper.js";
import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
const region = process.env.region
const dynamo = new DynamoDBClient({ region: region });

export const handler = async (event) => {
    try {

        for (const record of event.Records) {
            const { offerId, createdAt } = JSON.parse(record.body);
            console.log("offerId*********", offerId);
            console.log("createdAt*********", createdAt);

            const command = new GetItemCommand({
                TableName: process.env.PROV_BOOKING_TABLE, // replace with your table name
                Key: {
                    offerId: { S: offerId } // partition key must match type
                }
            });


            const response = await dynamo.send(command);
            if (response.Item) {
                console.log("Item found:", response.Item);
                response.Item;
            } else {
                console.log("No item found for offerId:", offerId);
                return {
                    statusCode: 200,
                    ...globalHeaders(),
                    body: "No data found against this offerId",
                };
            }

            const { status } = response.Item;
            console.log("status*********", status);

            // Convert createdAt to Date
            const createdDate = new Date(createdAt);

            // Current time
            const now = new Date();

            // Difference in minutes
            const diffMinutes = (now - createdDate) / (1000 * 60);
            console.log("diffMinutes*****", diffMinutes);

            if (diffMinutes >= 1 && status.S === 'pending') {
                console.log(`Offer ${offerId} is older than 20 minutes`);

                const updateCmd = new UpdateItemCommand({
                    TableName: process.env.PROV_BOOKING_TABLE,
                    Key: {
                        offerId: { S: offerId }, // PK
                    },
                    UpdateExpression: "SET #st = :status",
                    ExpressionAttributeNames: {
                        "#st": "status", // in case "status" is a reserved word
                    },
                    ExpressionAttributeValues: {
                        ":status": { S: "expired" }
                    }
                });

                await dynamo.send(updateCmd);
            } else {
                console.log(`Offer ${offerId} is within 20 minutes`);
            }
        }
        return {
            statusCode: 200,
            ...globalHeaders(),
            // body: JSON.stringify(response.data),
        };
    } catch (error) {
        return await InternalError(error)
    }
};
