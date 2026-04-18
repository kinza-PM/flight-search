import { globalHeaders, InternalError } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import {
    DynamoDBClient,
    ScanCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import redis from "../lib/redisClient.js";

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

        const userId = authVerification?.context?.sub
        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
        const { offerId } = body;
        const redisKey = `${offerId}-${userId}`
        const alreadyViewed = await redis.get(redisKey);
        let counts = 0
        if (!alreadyViewed) {
            // Increment DynamoDB count
            counts = await incrementOfferCount(offerId);

            // Mark this user-offer as counted (TTL few seconds)
            await redis.set(redisKey, "1", "EX", 30); // 30 seconds or your offer validity
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify({
                count: counts,
            }),
        };
    } catch (error) {
        return await InternalError(error)
    }
};

const incrementOfferCount = async (offerId) => {
    try {
        const ttlSeconds =
            Math.floor(Date.now() / 1000) + 30;

        const updateCmd = new UpdateItemCommand({
            TableName: process.env.OFFER_VIEWING_TABLE,
            Key: {
                offerId: { S: offerId }
            },
            UpdateExpression: `
        SET #count = if_not_exists(#count, :zero) + :inc,
            updatedAt = :time,
            expireAt = :ttl
      `,
            ExpressionAttributeNames: {
                "#count": "count"
            },
            ExpressionAttributeValues: {
                ":inc": { N: "1" },
                ":zero": { N: "0" },
                ":time": { S: new Date().toISOString() },
                ":ttl": { N: ttlSeconds.toString() }
            },
            ReturnValues: "UPDATED_NEW"
        });

        const result = await dynamo.send(updateCmd);
        const offerCounts = result.Attributes?.count?.N || 0;

        const redisKey = `${offerId}-counts`
        await redis.set(redisKey, offerCounts, "EX", 120);
        return offerCounts

    } catch (error) {
        console.log("incrementOfferCount error:", error);
        throw error;
    }
};
