import axios from "axios";
import { getSessionId, globalHeaders, InternalError, logTrace } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import { verifyToken } from "./authorizerLayer.js";
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const region = process.env.region
const dynamo = new DynamoDBClient({ region: region });
const BASE_URL = process.env.BASE_URL;

const sqsClient = new SQSClient({
  region: region,
});

export const handler = async (event) => {
  try {
    console.log("prov booking api is working *******");
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
    // const conversationId = uuidv4();

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
    const response = await axios.post(apiUrl, bookingPayload, axiosConfig);
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

    const provBookingObj = {
      offerId: response?.data?.data[0]?.offerId,
      priceChanged: response?.data?.data[0]?.priceChanged,
      oldFare: response?.data?.data[0]?.oldFare,
      newFare: response?.data?.data[0]?.newFare,
      detail: JSON.stringify(response?.data?.data[0]?.detail),
      financialInfo: JSON.stringify(response?.data?.data[0]?.financialInfo),
      fare: JSON.stringify(response?.data?.data[0]?.fare),
      userId: authVerification?.context?.sub,
      userType: authVerification?.context?.userType,
      request: bookingPayload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    // 2️⃣ Insert into DynamoDB
    const putCmd = new PutItemCommand({
      TableName: process.env.PROV_BOOKING_TABLE,
      Item: {
        offerId: { S: provBookingObj.offerId },                 // PK
        createdAt: { S: provBookingObj.createdAt },             // SK

        priceChanged: { BOOL: provBookingObj.priceChanged },
        oldFare: { N: String(provBookingObj.oldFare) },
        newFare: { N: String(provBookingObj.newFare) },

        detail: { S: provBookingObj.detail },
        financialInfo: { S: provBookingObj.financialInfo },
        fare: { S: provBookingObj.fare },

        userId: { S: provBookingObj.userId },
        userType: { S: provBookingObj.userType },

        request: { S: JSON.stringify(provBookingObj.request) },
        isValid: { BOOL: false },
        status: { S: "pending" },
        updatedAt: { S: provBookingObj.updatedAt },
      },
    });

    await dynamo.send(putCmd);

    // Send SQS message for the UPDATE EXPIRED BOOKING 
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: process.env.UPDATE_EXIRED_BOOKING,
        DelaySeconds: 300, // 5 minutes
        MessageBody: JSON.stringify({
          offerId: provBookingObj.offerId,
          createdAt: provBookingObj.createdAt
        })
      })
    );

    const payload = {
      id: uuidv4(),
      userId: authVerification?.context?.sub,
      userType: authVerification?.context?.userType,
      request: JSON.stringify(provBookingObj.request),
      response: JSON.stringify(response.data),
      offerId: provBookingObj.offerId,
      searchKey: searchKey,
      stepCode: 40,
      status: "active"
    };

    await logTrace(payload)
    // Success response
    console.log("response.data?.data[0].offerId*******", response.data?.data[0].offerId);

    const updateOfferIdInLogTrace = new UpdateItemCommand({
      TableName: process.env.LOG_TRACE_TABLE,
      Key: {
        id: { S: searchKey }, // PK
      },
      UpdateExpression: "SET offerId = :f, selectedFlightCode = :sfc",
      ConditionExpression: "attribute_exists(id)",
      ExpressionAttributeValues: {
        ":f": { S: response.data?.data[0].offerId },
        ":sfc": { S: journey[0].flightSegments[0].marketingAirline },
      }
    });

    await dynamo.send(updateOfferIdInLogTrace);
    return {
      statusCode: 200,
      ...globalHeaders(),
      body: JSON.stringify(response.data),
    };
  } catch (error) {
    return await InternalError(error)
  }
};

// Utility: Consistent 400 error format
const badRequest = (message, statusCode = 400) => ({
  statusCode: statusCode,
  ...globalHeaders(),
  body: JSON.stringify({ message }),
});

