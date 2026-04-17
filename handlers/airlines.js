import axios from "axios";
import { getSessionId, globalHeaders, logTrace } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";

const BASE_URL = process.env.BASE_URL;
const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 3600); // 1 hour

export const handler = async (event) => {
    try {
        // Verify authentication
        const authVerification = await verifyToken(event);
        console.log("Auth verification:", JSON.stringify(authVerification, null, 2));

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

        // Check cache first
        const cacheKey = createCacheKey({ endpoint: "airlines" }, "airlines");

        try {
            const cachedData = await redis.get(cacheKey);
            if (cachedData) {
                console.log("Returning cached airlines data");
                return {
                    ...globalHeaders(),
                    statusCode: 200,
                    body: JSON.stringify({
                        success: true,
                        data: JSON.parse(cachedData),
                        cached: true,
                    }),
                };
            }
        } catch (cacheError) {
            console.warn("Cache retrieval failed:", cacheError.message);
            // Continue without cache
        }

        // Get session ID from supplier
        const { sessionId, conversationId } = await getSessionId(userId);
        console.log("Session ID obtained:", sessionId);

        // Call supplier airlines endpoint
        const url = `${BASE_URL}/flight/airlines`;
        console.log("Calling supplier endpoint:", url);

        const response = await axios.get(url, {
            headers: {
                "Content-Type": "application/json",
                "X-API-KEY": process.env.X_API_KEY,
                sessionId,
                conversationId
            }
        });

        console.log("response***********", response);


        const airlinesData = response.data;
        console.log("Airlines data received from supplier:", JSON.stringify(airlinesData, null, 2));

        // Extract airlines list from supplier response
        const airlines = airlinesData?.data || [];

        // Cache the result
        try {
            await redis.setex(cacheKey, CACHE_TTL_DEFAULT, JSON.stringify(airlinesData));
            console.log("Airlines data cached successfully");
        } catch (cacheError) {
            console.warn("Failed to cache airlines data:", cacheError.message);
        }

        // Log trace for analytics
        try {
            await logTrace({
                endpoint: "/airlines",
                userId,
                sessionId,
                status: "success",
                airlinesCount: airlines.length,
            });
        } catch (logError) {
            console.warn("Failed to log trace:", logError.message);
        }

        return {
            ...globalHeaders(),
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                meta: airlinesData?.meta,
                commonData: airlinesData?.commonData,
                data: airlines,
                cached: false,
            }),
        };

    } catch (error) {
        console.error("Error fetching airlines:", error);
        console.error("Error stack:", error.stack);

        // Log error trace
        try {
            await logTrace({
                endpoint: "/airlines",
                status: "error",
                error: error.message,
                errorCode: error.code,
            });
        } catch (logError) {
            console.warn("Failed to log error trace:", logError.message);
        }

        // Handle specific error types
        if (error.response?.status === 401) {
            return {
                ...globalHeaders(),
                statusCode: 401,
                body: JSON.stringify({
                    success: false,
                    message: "Unauthorized: Invalid supplier credentials",
                }),
            };
        }

        if (error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
            return {
                ...globalHeaders(),
                statusCode: 503,
                body: JSON.stringify({
                    success: false,
                    message: "Supplier service unavailable",
                }),
            };
        }

        return {
            ...globalHeaders(),
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                message: "Failed to fetch airlines data",
                error: error.message,
            }),
        };
    }
};