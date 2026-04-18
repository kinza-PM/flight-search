import axios from "axios";
import { getSessionId, globalHeaders, InternalError, logTrace } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
const region = process.env.REGION
const BASE_URL = process.env.BASE_URL;
const sqsClient = new SQSClient({
  region: region,
});

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

    const body =
      typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};

    const MAIN_ENDPOINT = process.env.MAIN_ENDPOINT
    const {
      offerId,
      journey,
      passengers,
      reservationType,
      paymentDetails,
      searchKey
    } = body;

    // Input validation
    if (!offerId) {
      return badRequest("Missing required field: offerId");
    }
    if (!searchKey) {
      return badRequest("Missing required field: searchKey");
    }
    if (!Array.isArray(journey) || journey.length === 0) {
      return badRequest("journey must be a non-empty array");
    }
    if (!Array.isArray(passengers) || passengers.length === 0) {
      return badRequest("passengers must be a non-empty array");
    }
    if (!reservationType) {
      return badRequest("reservationType is required");
    }
    if (!paymentDetails || typeof paymentDetails !== "object") {
      return badRequest("paymentDetails must be a valid object");
    }
    if (!paymentDetails?.paymentMode || (paymentDetails?.paymentMode === "CC" && !paymentDetails?.cardInfo)) {
      return {
        statusCode: 400,
        ...globalHeaders(),
        body: JSON.stringify({
          message: "Missing required field: cardInfo (required for Credit Card payment)",
        }),
      };
    }

    // Fetch session ID from upstream
    const { sessionId, conversationId } = await getSessionId(authVerification?.context?.sub, searchKey);
    console.log("conversationId********", conversationId);

    if (!sessionId) {
      console.error("No sessionId returned from upstream API.");
      return badRequest("Login failed — no sessionId returned from upstream.", 422);
    }

    if (!conversationId) {
      return {
        ...globalHeaders(),
        statusCode: 500,
        body: JSON.stringify({ message: "Login failed, no conversationId returned." }),
      };
    }

    // Payload for flight provisional booking
    const bookingPayload = {
      offerId,
      journey,
      passengers,
      reservationType,
      paymentDetails,
    };

    const startTime = Date.now();

    // Secure Axios config
    const axiosConfig = {
      timeout: 45000, // 15s timeout
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.X_API_KEY,
        conversationId,
        sessionId,
      },
      validateStatus: (status) => status < 500, // don't throw for 4xx
    };


    // API call
    const apiUrl = `${BASE_URL}/reservation/flight-prov-book`;
    let response = await axios.post(apiUrl, bookingPayload, axiosConfig);
    const endTime = Date.now();
    const durationMs = endTime - startTime;

    console.log(`main Upstream API response time: ${durationMs} ms`);
    // Handle 4xx from upstream
    if (response.status >= 400) {
      console.warn("Upstream API returned error:", response.status);
      return {
        statusCode: response.status,
        ...globalHeaders(),
        body: JSON.stringify({
          message: "Upstream API error",
          details: response.data || "Unexpected upstream error",
        }),
      };
    }

    console.log("response?.data?.asyncFetch********", response?.data?.asyncFetch);

    if (response?.data?.asyncFetch) {


      const startTime = Date.now();

      try {
        const fetchUrl = response?.data?.asyncFetch?.fetchUrl;
        const url = `${MAIN_ENDPOINT}${fetchUrl}`;
        console.log("url************", url);
        const res = await axios.get(url, {
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": process.env.X_API_KEY,
            sessionId,
            conversationId
          }
        });

        // console.log("res.data******", JSON.stringify(res.data, null, 2));
        const endTime = Date.now();
        const durationMs = endTime - startTime;

        console.log(`fetch api Upstream API response time: ${durationMs} ms`);
        if (res.data?.meta?.success === true && res.data?.data?.length > 0) {
          response['data'] = res.data;
        }

      } catch (err) {
        console.error("Async fetch failed:", err?.message || err);

        // Optional: log but DO NOT fail main flow
        // fallback to original response
      }
    }
    // console.log("after fetch response?.data********", response?.data);
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: process.env.ASYNC_PROV_BOOKING_QUEUE,
      MessageBody: JSON.stringify({
        data: JSON.stringify(response.data),
        userId: authVerification?.context?.sub,
        userType: authVerification?.context?.userType,
        searchKey: searchKey,
        marketingAirline: journey[0].flightSegments[0].marketingAirline,
        bookingPayload: JSON.stringify(bookingPayload)
      })
    }));

    return {
      statusCode: 200,
      ...globalHeaders(),
      body: JSON.stringify(response.data),
    };

  } catch (error) {
    console.log("error********", error)
    return await InternalError(error)
  }
};

// Utility: Consistent 400 error format
const badRequest = (message, statusCode = 400) => ({
  statusCode: statusCode,
  ...globalHeaders(),
  body: JSON.stringify({ message }),
});

