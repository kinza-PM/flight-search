import axios from "axios";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  GetItemCommand
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4 } from "uuid";
const dynamo = new DynamoDBClient({ region: process.env.REGION });
const region = process.env.REGION
const s3 = new S3Client({ region: region });
const sqsClient = new SQSClient({
  region: region,
});

const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 21000); // 5h 50m in seconds
const CACHE_TTL_MIN = 30;
const CACHE_TTL_MAX = 300;

/**
 * Retrieves a sessionId from AlRais authentication API.
 * Includes improved validation, logging, and error handling for production safety.
 */
export const getSessionId = async (userId, searchKey = null) => {
  const loginUrl = `${process.env.BASE_URL}/auth/login`;

  try {
    // Validate required environment variables
    const requiredEnv = ["USERNAME", "PASSWORD", "COMPANY_CODE", "X_API_KEY", "BASE_URL"];
    for (const key of requiredEnv) {
      if (!process.env[key]) {
        throw new Error(`Missing environment variable: ${key}`);
      }
    }

    const cacheKey = createCacheKey({ fetchsSessionId: "fetchsSessionId" }, "sessionIdxxxx");

    try {
      const cacheRaw = await redis.get(cacheKey);
      const cached = cacheRaw ? JSON.parse(cacheRaw) : null

      if (cached) {
        console.log("cache condition is running abc*******");

        const conversationId = await getConversationIdFromRedis(userId, searchKey, null)
        console.log("cached conversationId**********", conversationId);

        // Return cache hit
        console.info("checker Cache HIT for", cacheKey);
        const sessionId = cached?.data?.[0]?.sessionId;
        return { sessionId, conversationId }
      }
      console.info("Cache MISS for", cacheKey);
    } catch (redisErr) {
      console.error("Redis GET error (proceeding to API):", redisErr);
      // proceed to call supplier
    }

    // API call to login
    const response = await axios.post(
      loginUrl,
      {
        userName: process.env.USERNAME,
        password: process.env.PASSWORD,
        companyCode: process.env.COMPANY_CODE,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": process.env.X_API_KEY,
        },
        timeout: 10000, // 10 seconds timeout for safety
        validateStatus: (status) => status < 500, // treat 4xx as handled errors
      }
    );

    const ttlFromSupplier = computeTTLFromSupplier(response.data);
    console.log("ttlFromSupplier************", ttlFromSupplier);
    console.log("CACHE_TTL_DEFAULT***********", CACHE_TTL_DEFAULT);

    const ttl = ttlFromSupplier || CACHE_TTL_DEFAULT;
    console.log("final ttl*********", ttl);

    // Write to redis (stringify)
    try {
      await redis.set(cacheKey, JSON.stringify(response.data), "EX", ttl);
      console.info("Cached result", cacheKey, "ttl", ttl);
    } catch (redisWriteErr) {
      console.error("Redis SET error:", redisWriteErr);
      // Optionally push to SQS for async caching if required
    }
    // Validate API structure
    console.log("response?.data?.data*********", response?.data?.data);

    const sessionId = response?.data?.data?.[0]?.sessionId;
    const conversationId = uuidv4();
    console.log("main conversationId *****", conversationId);

    await getConversationIdFromRedis(userId, searchKey, conversationId)

    if (!sessionId) {
      console.error("Invalid login response:", JSON.stringify(response.data, null, 2));
      throw new Error("Login API did not return a valid sessionId.");
    }

    // Return structured result
    return { sessionId, conversationId };
  } catch (error) {
    return await InternalError(error)
  }
};

export const InternalError = async (error) => {
  if (error.response) {
    console.error("🔴 Provesio API responded with error:");
    console.error("Status:", error.response.status);
    console.error("Headers:", JSON.stringify(error.response.headers, null, 2));
    console.error("Data:", JSON.stringify(error.response.data, null, 2));

    return {
      statusCode: error.response.status,
      headers: {
        "Access-Control-Allow-Origin": "*", // ← allow all origins
        "Access-Control-Allow-Credentials": true, // ← allow cookies if needed
      },
      body: JSON.stringify({
        message: "Provesio API Error",
        status: error.response.status,
        response: error.response.data,
      }),
    };
  }

  // 🔸 Request was sent but no response received
  if (error.request) {
    console.error("🟠 No response received from Provesio API");
    console.error("Request:", error.request);

    return {
      statusCode: 504,
      headers: {
        "Access-Control-Allow-Origin": "*", // ← allow all origins
        "Access-Control-Allow-Credentials": true, // ← allow cookies if needed
      },
      body: JSON.stringify({
        message: "No response received from Provesio API",
      }),
    };
  }

  console.error("⚠️ Unexpected internal error:", error.message);
  return {
    statusCode: 500,
    headers: {
      "Access-Control-Allow-Origin": "*", // ← allow all origins
      "Access-Control-Allow-Credentials": true, // ← allow cookies if needed
    },
    body: JSON.stringify({
      message: "Internal server error",
      error: error.message,
    }),
  };

}

export const globalHeaders = () => {
  return {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": true,
      "Access-Control-Allow-Headers": "Content-Type, X-API-KEY, user_type, user_id, Authorization",
    }
  }
}

export const computeTTLFromSupplier = (resp) => {
  // Adjust this function according to Provesio response format.
  // Example: resp.meta.price_valid_until = "2025-11-20T12:00:00Z"
  const tv = resp?.meta?.price_valid_until || resp?.price_valid_until;
  if (!tv) return null;
  const then = new Date(tv).getTime();
  const now = Date.now();
  if (isNaN(then)) return null;
  const secs = Math.floor((then - now) / 1000);
  if (secs <= 0) return null;
  return Math.max(CACHE_TTL_MIN, Math.min(CACHE_TTL_MAX, secs));
}

export const logTrace = async (payload) => {

  try {
    const fileContent = JSON.stringify(payload);

    // key example: logs/2025-01-01/<uuid>.json
    const key = `logs/${Date.now()}-${payload.id}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.LOG_TRACE_BUCKET,
        Key: key,
        Body: fileContent,
        ContentType: "application/json",
      })
    );

    const command = new SendMessageCommand({
      QueueUrl: process.env.LOG_TRACE_SQS,
      MessageBody: JSON.stringify({ key }),
    });

    await sqsClient.send(command);

    return payload
  } catch (error) {
    return await InternalError(error)
  }
};

export const getConversationIdFromRedis = async (userId, searchKey, conversationId) => {
  try {
    console.log("getConversationIdFromRedis function is running ");
    console.log("new conversationId********", conversationId);
    const conversationIdKey = `conversationId:${userId}`

    if (conversationId) {
      console.log("create conversation redis key condition******************");

      await redis.set(conversationIdKey, JSON.stringify(conversationId), "EX", 1500);
      return conversationIdKey
    } else {
      console.log("in else condition *********");

      if (!conversationId && !searchKey) {
        console.log("in condition 2 null *************");
        const generateConversationId = uuidv4()
        const cacheRaw = await redis.get(conversationIdKey);
        const conversationIdData = JSON.parse(cacheRaw);
        console.log("checker conversationIdData**********", conversationIdData);

        if (!conversationIdData) {
          console.log("conversationIdData condition********");
          await redis.set(conversationIdKey, JSON.stringify(generateConversationId), "EX", 1500);
        }
        return cacheRaw ? JSON.parse(cacheRaw) : generateConversationId;
      }

      console.log("below the condition is running***********fff*");

      const { Item } = await dynamo.send(
        new GetItemCommand({
          TableName: process.env.LOG_TRACE_TABLE,
          Key: {
            id: { S: searchKey },
          },
        })
      );
      console.log("checker item**********", Item);
      if (!Item) {
        console.log("in mock condition ****************");

        return uuidv4();
      }

      const item = unmarshall(Item);


      const redisKey =
        item.userType === "guest"
          ? `conversationId:${item.userId}`
          : `conversationId:${userId}`;

      const cacheRaw = await redis.get(redisKey);
      const finalRedisConverationId = cacheRaw ? JSON.parse(cacheRaw) : uuidv4();
      console.log("redis cache conversationId******************", finalRedisConverationId);

      return finalRedisConverationId
    }

  } catch (error) {
    return InternalError(error);
  }
};

export const removedConverationId = async (userId, searchKey) => {
  try {
    console.log("getConversationIdFromRedis function is running ");
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: process.env.LOG_TRACE_TABLE,
        Key: {
          id: { S: searchKey },
        },
      })
    );

    if (!Item) return null;

    const item = unmarshall(Item);

    const redisKey =
      item.userType === "guest"
        ? `conversationId:${item.userId}`
        : `conversationId:${userId}`;
    const deletedCount = await redis.del(redisKey);
    console.log("Deleted keys:", deletedCount);
  } catch (error) {
    return InternalError(error);
  }
};

export const flightSearchData = async (payload) => {

  try {
    const fileContent = JSON.stringify(payload);

    // key example: logs/2025-01-01/<uuid>.json
    const key = `flightSearchData/${Date.now()}-${payload.cacheKey}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.FLIGHT_SEARCH_BUCKET,
        Key: key,
        Body: fileContent,
        ContentType: "application/json",
      })
    );

    const command = new SendMessageCommand({
      QueueUrl: process.env.FLIGHT_SEARCH_OPERATION_QUEUE,
      MessageBody: JSON.stringify({ key }),
    });

    await sqsClient.send(command);

    return payload
  } catch (error) {
    return await InternalError(error)
  }
};


export const attachOfferViewCounts = async (offers) => {
  if (!Array.isArray(offers)) return offers;

  const keys = offers.map(o => `${o.offerId}-counts`);
  const counts = await Promise.all(keys.map(k => redis.get(k)));

  offers.forEach((offer, index) => {
    offer.offerViewCount = counts[index]
      ? parseInt(counts[index])
      : 0;
  });

  return offers;
};


export const streamToString = async (stream) =>
  await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });

