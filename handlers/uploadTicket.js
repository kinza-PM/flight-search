import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { globalHeaders, InternalError, logTrace } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
const region = process.env.region
import {
    DynamoDBClient,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
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

        if (authVerification?.context?.userType === 'guest') {
            return {
                ...globalHeaders(),
                statusCode: 401,
                body: JSON.stringify({
                    message: "Unauthorized: Guest User is not allowed for reservation booking",
                }),
            };
        }

        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};

        const { ticketImage, offerId } = body;
        if (!offerId) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "Missing required field: offerId" }),
            };
        }

        if (!ticketImage) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "Missing required field: ticketImage" }),
            };
        }

        const updateTicketImage = new UpdateItemCommand({
            TableName: process.env.PROV_BOOKING_TABLE,
            Key: {
                offerId: { S: offerId },   // PK
            },
            UpdateExpression: "SET ticketImage = :tI",
            ExpressionAttributeValues: {
                ":tI": { S: ticketImage }
            }
        });

        await dynamo.send(updateTicketImage);


        const payload = {
            id: uuidv4(),
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            request: JSON.stringify(body),
            stepCode: 140,
            status: "active"
        };

        await logTrace(payload)

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: "booking ticket upload successfully ",
        };
    } catch (error) {
        return await InternalError(error)
    }
};
