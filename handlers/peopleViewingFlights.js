import redis from "../lib/redisClient.js";
import { getSessionId, globalHeaders, InternalError } from "../helper/helper.js";
import {
    DynamoDBClient,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";

const region = process.env.region;
const dynamo = new DynamoDBClient({ region });

export const handler = async (event) => {
    try {
        for (const record of event.Records) {
            const searches = JSON.parse(record.body);

            for (const search of searches) {
                const { departureAirportCode, arrivalAirportCode, cabinPreferences } = search;

                // Compose route and cabin class
                const route = `${departureAirportCode}-${arrivalAirportCode}`;
                const cabinClass = cabinPreferences[0]; // single preference

                // TTL: 10 minutes from now (in seconds since epoch)
                const ttlSeconds = Math.floor(Date.now() / 1000) + parseInt(process.env.PEOPLE_VIEWING_TTL) * 60;

                // Update DynamoDB and get updated count
                const updateCmd = new UpdateItemCommand({
                    TableName: process.env.PEOPLE_VIEWING_TABLE,
                    Key: {
                        route: { S: route },
                        cabinClass: { S: cabinClass }
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
                    ReturnValues: "UPDATED_NEW" // <-- return the updated attributes
                });

                const result = await dynamo.send(updateCmd);
                const updatedCount = result.Attributes?.count?.N || "0";

                // Store in Redis with key route-cabinClass
                const redisKey = `${route}-${cabinClass}`;
                await redis.set(redisKey, updatedCount, "EX", parseInt(process.env.PEOPLE_VIEWING_TTL) * 60);
            }
        }

        return { statusCode: 200, body: "People viewing updated successfully" };

    } catch (error) {
        console.log("error*********", error);
        return await InternalError(error);
    }
};


import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";

