import { attachOfferViewCounts, computeTTLFromSupplier, InternalError, logTrace, streamToString } from "../helper/helper.js";
import redis from "../lib/redisClient.js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
    S3Client,
    GetObjectCommand
} from "@aws-sdk/client-s3";
const s3 = new S3Client({ region: process.env.REGION });
const region = process.env.REGION

const sqsClient = new SQSClient({
    region: region,
});

const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 180); // seconds

export const handler = async (event) => {

    for (const record of event.Records) {
        try {
            const body = JSON.parse(record.body);
         
            const { key } = body;

            const s3Resp = await s3.send(
                new GetObjectCommand({
                    Bucket: process.env.FLIGHT_SEARCH_BUCKET,
                    Key: key,
                })
            );

            const fileContent = await streamToString(s3Resp.Body);
            let { flightData, userId, userType, searchPayload, flightSegments, browserId, cacheKey } = JSON.parse(fileContent);

        
            flightData = typeof flightData === 'string' ? JSON.parse(flightData) : flightData
            flightSegments = typeof flightSegments === 'string' ? JSON.parse(flightSegments) : flightSegments

            await attachOfferViewCounts(flightData?.data)
            // Save logs in DB here (only on MISS) ---- implement your DB write
            // await saveSearchLog({ request: searchPayload, response: searchResp.data, cacheKey, conversationId });

            // Decide TTL
            const ttlFromSupplier = computeTTLFromSupplier(flightData);
            const ttl = ttlFromSupplier || CACHE_TTL_DEFAULT;

            // Write to redis (stringify)
            try {
                await redis.set(cacheKey, JSON.stringify(flightData), "EX", ttl);
                console.info("Cached result", cacheKey, "ttl", ttl);
            } catch (redisWriteErr) {
                console.error("Redis SET error:", redisWriteErr);
                // Optionally push to SQS for async caching if required
            }

            const payload = {
                id: flightData?.commonData?.searchKey,
                userId: userId,
                userType: userType,
                request: searchPayload,
                stepCode: 10,
                status: "active",
                searchKey: flightData?.commonData?.searchKey
            };

            await logTrace(payload);

            await sqsClient.send(new SendMessageCommand({
                QueueUrl: process.env.PEOPLE_VIEWING_FLIGHTS_QUEUE,
                MessageBody: JSON.stringify(flightSegments)
            }));


            const userSearchPreferencesList = flightSegments.map(segment => ({
                departureAirportCode: segment.departureAirportCode,
                arrivalAirportCode: segment.arrivalAirportCode,
                userId: userId,
                browserId: browserId,
                userType: userType
            }));

            await sqsClient.send(new SendMessageCommand({
                QueueUrl: process.env.USER_SEARCH_PREFERENCES_QUEUE,
                MessageBody: JSON.stringify(userSearchPreferencesList)
            }));

        } catch (error) {
            console.error("Record failed", {
                body: record.body,
                error: error.message,
                stack: error.stack,
            });

            // DON'T return or throw
            continue;
        }


    }
};
