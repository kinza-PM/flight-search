import axios from "axios";
import { attachOfferViewCounts, flightSearchData, getSessionId, globalHeaders, InternalError } from "../helper/helper.js";
import airlines from 'airline-codes';
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { verifyToken } from "./authorizerLayer.js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  DynamoDBClient,
  QueryCommand
} from "@aws-sdk/client-dynamodb";
import { airlineLogos } from "../helper/airlineLogos.js";
const sqsClient = new SQSClient({
  region: process.env.REGION,
});
const dynamo = new DynamoDBClient({ region: process.env.REGION });

import { unmarshall } from "@aws-sdk/util-dynamodb";


const BASE_URL = process.env.BASE_URL;
const MAIN_ENDPOINT = process.env.MAIN_ENDPOINT;
const CACHE_TTL_DEFAULT = Number(process.env.CACHE_TTL_DEFAULT || 120); // seconds

export const handler = async (event) => {
  try {
    const authVerification = await verifyToken(event);
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
    let searchResp = ''
    // const conversationId = uuidv4();
    const {
      flightSegments,
      preference,
      passengers,
      maxConnections,
      browserId
    } = body || {};


    const highDemandResult = [];

    for (const segment of flightSegments) {
      const departureAirportCode = segment.departureAirportCode;
      const arrivalAirportCode = segment.arrivalAirportCode;

      const queryCmd = new QueryCommand({
        TableName: process.env.HIGH_DEMAND_INDICATOR_TABLE,
        KeyConditionExpression: "departureAirportCode = :dep AND begins_with(routeAirline, :route)",
        ExpressionAttributeValues: {
          ":dep": { S: departureAirportCode },
          ":route": { S: `${arrivalAirportCode}#` },
        },
      });

      const response = await dynamo.send(queryCmd);

      if (!response.Items || response.Items.length === 0) {
        continue;
      }

      // Convert + find highest count
      let maxItem = null;

      for (const item of response.Items) {
        const data = unmarshall(item);

        if (!maxItem || data.totalCounts > maxItem.totalCounts) {
          maxItem = data;
        }
      }

      if (maxItem) {
        highDemandResult.push({
          marketingAirline: maxItem.marketingAirline,
          totalCounts: maxItem.totalCounts,
          highDemand: true,
        });
      }
    }


    // --- validation (your existing code) ---
    if (maxConnections !== undefined && ![0, 1, 2].includes(maxConnections)) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "maxConnections should be 0, 1, or 2" }),
      };
    }
    if (!Array.isArray(flightSegments) || flightSegments.length === 0) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "flightSegments is required and must be a non-empty array" }),
      };
    }
    for (let i = 0; i < flightSegments.length; i++) {
      const segment = flightSegments[i];
      const { departureAirportCode, departureDate, arrivalAirportCode, cabinPreferences } = segment;
      if (!departureAirportCode || !departureDate || !arrivalAirportCode) {
        return {
          ...globalHeaders(),
          statusCode: 400,
          body: JSON.stringify({
            message: `Segment ${i + 1}: departureAirportCode, departureDate, and arrivalAirportCode are required.`
          }),
        };
      }
      if (!Array.isArray(cabinPreferences) || cabinPreferences.length === 0 || cabinPreferences.some(item => !item || item.trim() === "")) {
        return {
          ...globalHeaders(),
          statusCode: 400,
          body: JSON.stringify({
            message: `Segment ${i + 1}: cabinPreferences is required and must not contain empty values.`
          }),
        };
      }
    }
    if (!Array.isArray(passengers) || passengers.length === 0) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "passengers is required and must be a non-empty array." }),
      };
    }
    if (preference && Array.isArray(preference.farePreference) && preference.farePreference.length === 0) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "farePreference should be array of object and should be valid farePreference code." }),
      };
    }

    // Session ID
    const { sessionId, conversationId } = await getSessionId(authVerification?.context?.sub);
    console.log("sessionId*********", sessionId);
    console.log("conversationId*********", conversationId);
    if (!sessionId) {
      return {
        ...globalHeaders(),
        statusCode: 500,
        body: JSON.stringify({ message: "Login failed, no sessionId returned." }),
      };
    }

    if (!conversationId) {
      return {
        ...globalHeaders(),
        statusCode: 500,
        body: JSON.stringify({ message: "Login failed, no conversationId returned." }),
      };
    }

    // Prepare payload
    const searchPayload = {
      flightSegments,
      passengers,
      preference: {
        flightPreference: {
          directPreferences: false,
        },
      },
      formOfPayment: "CR",
      travelType: "P",
      responseParameters: {
        shopResultPreference: "OPTIMIZED",
        responseTimeout: 30,
      },
    };

    if (preference?.farePreference?.length > 0) {
      searchPayload.preference.farePreference = preference.farePreference;
    }
    if (maxConnections !== undefined && maxConnections !== null) {
      searchPayload.preference.flightPreference.maxConnections = maxConnections;
    }
    if (preference?.baggagePreference) {
      searchPayload.preference.baggagePreference = preference.baggagePreference;
    }

    // ---- CACHING: CHECK REDIS ----
    const cacheKey = createCacheKey({ flightSegments, passengers, preference, maxConnections }, "flightSearch");

    try {
      console.info("Cache HIT for", cacheKey);
      const cached = await redis.get(cacheKey);

      if (cached) {
        // Return cache hit
        const parsedCache = JSON.parse(cached);
        await attachOfferViewCounts(parsedCache.data);
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

    // ---- CALL PROVESIO ----
    searchResp = await axios.post(
      `${BASE_URL}/flight/search`,
      searchPayload,
      {
        timeout: 45000,
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": process.env.X_API_KEY,
          conversationId,
          sessionId,
        },
      }
    );

    if (searchResp?.data?.data?.asyncFetch?.fetchUrl) {
      const asyncResp = await axios.post(
        `${MAIN_ENDPOINT}${searchResp.data.data?.asyncFetch?.fetchUrl}`,
        searchPayload,
        {
          timeout: 45000,
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": process.env.X_API_KEY,
            conversationId,
            sessionId,
          },
        }
      );
      searchResp = asyncResp?.data?.data;
    }

    const offers = searchResp?.data?.data;

    if (!Array.isArray(offers) || offers.length === 0) {
      return {
        ...globalHeaders(),
        statusCode: 200,
        body: JSON.stringify({ message: searchResp?.data || "No data found" }),
      };
    }

    if (searchResp?.data?.data?.length) {
      searchResp.data.data = searchResp.data.data.map((offer, offerIndex) => {

        if (offer?.journey?.length) {
          offer.journey = offer.journey.map((journey, journeyIndex) => {


            if (journey?.flightSegments?.length) {
              journey.flightSegments = journey.flightSegments.map((segment, segIndex) => {
                const airlineCode = segment?.marketingAirline?.trim()?.toUpperCase();
                const airline = airlines.findWhere({ iata: airlineCode });

                return {
                  ...segment,
                  marketingAirlineLogo: airlineLogos[airlineCode] || null,
                  marketingAirlineFullName: airline
                    ? airline.get('name')
                    : airlineCode
                };
              });
            }

            return journey;
          });
        }

        return offer;
      });

    } else {

      console.log("❌ No data found in response");
    }

    const flightSearchOperationObj = {
      flightData: JSON.stringify(searchResp?.data),
      userId: authVerification?.context?.sub,
      userType: authVerification?.context?.userType,
      searchPayload: JSON.stringify(searchPayload),
      flightSegments: JSON.stringify(flightSegments),
      browserId: browserId,
      cacheKey: cacheKey
    };

    await flightSearchData(flightSearchOperationObj)

    const randomNumber = Math.floor(Math.random() * 5) + 1;
    searchResp['data']['highDemandIndicators'] = highDemandResult
    searchResp['data']['peopleViewing'] = randomNumber

    return {
      statusCode: 200,
      ...globalHeaders(),
      body: JSON.stringify(searchResp.data),
    };


  } catch (error) {
    console.error("Record failed", {
      error: error.message,
      stack: error.stack,
    });

    return await InternalError(error)
  }
};


