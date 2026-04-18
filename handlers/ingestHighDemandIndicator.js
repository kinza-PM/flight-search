import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { InternalError } from "../helper/helper.js";

const region = process.env.REGION

const dynamo = new DynamoDBClient({ region: region });
export const handler = async (event) => {
    try {
        for (const record of event.Records) {
            const body = JSON.parse(record.body);

            const {
                request,
                selectedFlightCode,
            } = body;

            const parsedRequest = JSON.parse(request);
            const flightSegments = parsedRequest.flightSegments;

            for (const segment of flightSegments) {
                const departureAirportCode = segment.departureAirportCode;
                const arrivalAirportCode = segment.arrivalAirportCode;
                const routeAirline = `${arrivalAirportCode}#${selectedFlightCode}`;

                /** 1️⃣ Check if item exists */
                const getCmd = new GetItemCommand({
                    TableName: process.env.HIGH_DEMAND_INDICATOR_TABLE,
                    Key: {
                        departureAirportCode: { S: departureAirportCode },
                        routeAirline: { S: routeAirline },
                    },
                });

                const result = await dynamo.send(getCmd);

                /** 2️⃣ If exists → increment count */
                if (result.Item) {
                    await dynamo.send(
                        new UpdateItemCommand({
                            TableName: process.env.HIGH_DEMAND_INDICATOR_TABLE,
                            Key: {
                                departureAirportCode: { S: departureAirportCode },
                                routeAirline: { S: routeAirline },
                            },
                            UpdateExpression: "SET totalCounts = totalCounts + :inc",
                            ExpressionAttributeValues: {
                                ":inc": { N: "1" },
                            },
                        })
                    );
                }

                /** 3️⃣ If not exists → insert */
                else {
                    await dynamo.send(
                        new PutItemCommand({
                            TableName: process.env.HIGH_DEMAND_INDICATOR_TABLE,
                            Item: {
                                departureAirportCode: { S: departureAirportCode },
                                routeAirline: { S: routeAirline },
                                arrivalAirportCode: { S: arrivalAirportCode },
                                marketingAirline: { S: selectedFlightCode },
                                status: { S: "booked" },
                                totalCounts: { N: "1" },
                            },
                        })
                    );
                }
            }
        }
    } catch (error) {
        return await InternalError(error)
    }
};