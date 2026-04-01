import axios from "axios";
import { computeTTLFromSupplier, getSessionId, globalHeaders, InternalError, logTrace } from "../helper/helper.js";
import redis from "../lib/redisClient.js";
import { verifyToken } from "./authorizerLayer.js";


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


        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
        const {
            passengers,
            type
        } = body || {};


        const cacheKey = `passenger_cache_${authVerification?.context?.sub}`
        if (!passengers) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "passengers details is required" }),
            };
        }

        if (!type || !["fetch", "add"].includes(type)) {
            return {
                ...globalHeaders(),
                statusCode: 400,
                body: JSON.stringify({ message: "type must be either 'fetch' or 'add'" }),
            };
        }

        if (type === 'fetch') {

            try {
                const cached = await redis.get(cacheKey);

                if (cached) {
                    const parsedCache = JSON.parse(cached);
                    console.info("cached data******** HIT for", cached);
                    return {
                        statusCode: 200,
                        ...globalHeaders(),
                        body: JSON.stringify(parsedCache), // already stringified
                    };
                }
                console.info("Cache MISS for", cacheKey);
            } catch (redisErr) {
                console.error("Redis GET error (proceeding to API):", redisErr);
                // proceed to call supplier
            }

        }


        try {
            await redis.set(cacheKey, JSON.stringify(passengers));
        } catch (redisWriteErr) {
            console.error("Redis SET error:", redisWriteErr);
            // Optionally push to SQS for async caching if required
        }
      
        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(passengers),
        };

    } catch (error) {
        return await InternalError(error)
    }
};
