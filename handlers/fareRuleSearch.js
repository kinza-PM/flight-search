import axios from "axios";
import { getSessionId, globalHeaders, InternalError, logTrace } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import { verifyToken } from "./authorizerLayer.js";
import redis from "../lib/redisClient.js";

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
    const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
    const { offerId, searchKey } = body;

    // Validate required field
    if (!offerId) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "Missings required field: offerId" }),
      };
    }

    if (!searchKey) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "Missings required field: searchKey" }),
      };
    }

    // Get sessionId
    const { sessionId, conversationId } = await getSessionId(authVerification?.context?.sub, searchKey);
    if (!sessionId) {
      console.error("Failed to obtain sessionId from Provesio API");
      return {
        ...globalHeaders(),
        statusCode: 500,
        body: JSON.stringify({
          message: "Login failed — no sessionId returned from upstream.",
        }),
      };
    }

    if (!conversationId) {
      return {
        ...globalHeaders(),
        statusCode: 500,
        body: JSON.stringify({ message: "Login failed, no conversationId returned." }),
      };
    }
    const cacheKey = offerId
    const cached = await redis.get(cacheKey);

    if (cached) {
      // Return cache hit
      const parsedCache = JSON.parse(cached);
      console.info("cached data******** HIT for", cached);
      return {
        statusCode: 200,
        ...globalHeaders(),
        body: JSON.stringify(parsedCache), 
      };
    }

    // Prepare request payload
    const searchPayload = { offerId };

    // Configure Axios securely
    const axiosConfig = {
      timeout: 15000, // 15s network timeout
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.X_API_KEY,
        conversationId,
        sessionId,
      },
      validateStatus: (status) => status < 500, // Don't throw for 4xx
    };

    // Make API call
    const ttl = 15 * 60;
    const apiUrl = `${process.env.BASE_URL}/flight/fare-rule-search`;
    const response = await axios.post(apiUrl, searchPayload, axiosConfig);
    await redis.set(cacheKey, JSON.stringify(response.data), "EX", ttl);
    // Handle upstream 4xx errors gracefully
    if (response.status >= 400) {
      console.warn("Provesio API returned error:", response.status, response.data);
      return {
        statusCode: response.status,
        ...globalHeaders(),
        body: JSON.stringify({
          message: "Upstream API error",
          details: response.data || "Unexpected response",
        }),
      };
    }
    const payload = {
      id: uuidv4(),
      userId: authVerification?.context?.sub,
      userType: authVerification?.context?.userType,
      request: searchPayload,
      stepCode: 30,
      status: "active"
    };

    await logTrace(payload);
    // Success
    return {
      statusCode: 200,
      ...globalHeaders(),
      body: JSON.stringify(response.data),
    };
  } catch (error) {
    return await InternalError(error)
  }
};
