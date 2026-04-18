import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { getSessionId, globalHeaders, InternalError, logTrace, removedConverationId } from "../helper/helper.js";
import { verifyToken } from "./authorizerLayer.js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.REGION
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand
} from "@aws-sdk/client-dynamodb";
const dynamo = new DynamoDBClient({ region: region });
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
    console.log("authVerification?.context?*********", authVerification?.context);

    if (authVerification?.context?.userType === 'guest') {
      return {
        ...globalHeaders(),
        statusCode: 401,
        body: JSON.stringify({
          message: "Unauthorized: Guest User is not allowed for reservation booking",
        }),
      };
    }

    const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
    // const conversationId = uuidv4();

    const { offerId, passengers, paymentDetails, searchKey } = body;
    let updateExpression = "SET #st = :s";
    let expressionAttributeValues = {
      ":s": { S: "completed" }
    };
    let expressionAttributeNames = {
      "#st": "status"
    };

    if (!offerId) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "Missing required field: offerId" }),
      };
    }

    if (!searchKey) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "Missing required field: searchKey" }),
      };
    }

    if (!Array.isArray(passengers) || passengers.length === 0) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "Missing required field: passengers (at least one)" }),
      };
    }

    if (!paymentDetails) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "Missing required field:  paymentDetails" }),
      };
    }

    const command = new GetItemCommand({
      TableName: process.env.PROV_BOOKING_TABLE, // replace with your table name
      Key: {
        offerId: { S: offerId } // partition key must match type
      }
    });


    const provBookingRes = await dynamo.send(command);
    console.log("provBookingRes*******", provBookingRes);

    if (provBookingRes.Item) {
      console.log("Item found:", provBookingRes.Item);
      provBookingRes.Item;
    } else {
      console.log("No item found for offerId:", offerId);
      return {
        statusCode: 200,
        ...globalHeaders(),
        body: "No data found against this offerId",
      };
    }

    console.log("provBookingRes*********", provBookingRes?.Item?.userType?.S);

    if (provBookingRes?.Item?.userType?.S === 'guest') {

      updateExpression += ", userType = :userType, userId = :userId";
      expressionAttributeValues[":userType"] = { S: "cognito" };
      expressionAttributeValues[":userId"] = { S: authVerification?.context?.sub };

    }

    // ✅ Step 2: Validate passenger data
    for (const [i, pax] of passengers.entries()) {
      if (!pax.passengerKey || !pax.ptc) {
        return {
          ...globalHeaders(),
          statusCode: 400,
          body: JSON.stringify({
            message: `Passenger ${i + 1} missing required fields: passengerKey or ptc`,
          }),
        };
      }

      const info = pax.passengerInfo || {};
      const requiredInfo = ["givenName", "surname", "gender", "birthDate", "nameTitle"];
      for (const field of requiredInfo) {
        if (!info[field]) {
          return {
            ...globalHeaders(),
            statusCode: 400,
            body: JSON.stringify({
              message: `Passenger ${i + 1} missing field in passengerInfo: ${field}`,
            }),
          };
        }
      }

      // Contact validation
      if (!pax.contact?.contactsProvided?.[0]) {
        return {
          ...globalHeaders(),
          statusCode: 400,
          body: JSON.stringify({
            message: `Passenger ${i + 1} missing contact.contactsProvided`,
          }),
        };
      }

      // Identity Document validation
      const idDoc = pax.identityDocuments?.[0];
      if (
        !idDoc ||
        !idDoc.idDocumentNumber ||
        !idDoc.idType ||
        !idDoc.issuingCountryCode ||
        !idDoc.residenceCountryCode ||
        !idDoc.expiryDate
      ) {
        return {
          ...globalHeaders(),
          statusCode: 400,
          body: JSON.stringify({
            message: `Passenger ${i + 1} missing identity document fields`,
          }),
        };
      }
    }

    // ✅ Step 3: Validate payment details
    const requiredPaymentFields = ["paymentMode", "transactionAmount"];
    for (const field of requiredPaymentFields) {
      if (!paymentDetails[field]) {
        return {
          ...globalHeaders(),
          statusCode: 400,
          body: JSON.stringify({
            message: `Missing required field in paymentDetails: ${field}`,
          }),
        };
      }
    }

    if (paymentDetails.paymentMode === "CR" && !paymentDetails.cardInfo) {
      return {
        statusCode: 400,
        ...globalHeaders(),
        body: JSON.stringify({
          message: "Missing required field: cardInfo (required for Credit Card payment)",
        }),
      };
    }

    // ✅ Step 4: Obtain sessionId from Provesio
    const { sessionId, conversationId } = await getSessionId(authVerification?.context?.sub, searchKey);
    if (!sessionId) {
      console.error("Failed to obtain sessionId from Provesio API");
      return {
        statusCode: 500,
        body: JSON.stringify({
          message: "Login failed — no sessionId returned from upstream.",
        }),
        ...globalHeaders()
      };
    }

    // ✅ Step 5: Prepare secure Axios config
    const axiosConfig = {
      timeout: 45000, // 15 seconds timeout
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.X_API_KEY,
        conversationId,
        sessionId,
      },
      validateStatus: (status) => status < 500, // Handle 4xx gracefully
    };

    const apiUrl = `${process.env.BASE_URL}/reservation/flight-book`;

    console.log("📤 Sending flight booking request to Provesio:", {
      url: apiUrl,
      conversationId,
      offerId,
      passengerCount: passengers.length,
    });

    // ✅ Step 6: Make the API call
    const response = await axios.post(apiUrl, body, axiosConfig);
    response['data']['sessionId'] = sessionId
    response['data']['conversationId'] = conversationId
    // ✅ Step 7: Handle upstream 4xx gracefully
    if (response.status >= 400) {
      console.warn("Provesio API returned error", response.status, response.data);
      return {
        ...globalHeaders(),
        statusCode: response.status,
        body: JSON.stringify({
          message: "Upstream API error",
          details: response.data || "Unexpected response",
        }),
      };
    }
    const bookingResponse = response?.data;

    if (bookingResponse.asyncFetch?.fetchUrl) {

      const fetchUrl = bookingResponse?.asyncFetch?.fetchUrl;

      // Send SQS message for the async fetch url
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: process.env.ASYNC_BOOKING_QUEUE,
        MessageBody: JSON.stringify({
          fetchUrl,
          offerId,
          sessionId,
          conversationId,
          requestBody: body,
          userId: authVerification?.context?.sub,
          userType: authVerification?.context?.userType
        })
      }));

    }
    else {

      const bookingObj = {
        bookingStatus: bookingResponse?.data[0].bookingStatus,
        priceChanged: bookingResponse?.data[0].priceChanged,
        bookingReferenceId: bookingResponse?.data[0].bookingReferenceId,
        financialInfo: JSON.stringify(bookingResponse?.data[0].financialInfo),
        passengers: JSON.stringify(bookingResponse?.data[0].passengers),
        fare: JSON.stringify(bookingResponse?.data[0].fare),
        ticketDocument: JSON.stringify(bookingResponse?.data[0].ticketDocument),
        request: JSON.stringify(body),
        userId: authVerification?.context?.sub,
        userType: authVerification?.context?.userType,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }

      const putCmd = new PutItemCommand({
        TableName: process.env.FLIGHT_BOOKING_TABLE,
        Item: {
          // 🔑 Keys
          bookingReferenceId: { S: bookingObj.bookingReferenceId },  // PK
          createdAt: { S: bookingObj.createdAt },                    // SK

          // Attributes
          bookingStatus: { S: bookingObj.bookingStatus },
          priceChanged: { BOOL: bookingObj.priceChanged },
          supplierLocator: { S: bookingObj.supplierLocator || "" },

          financialInfo: { S: bookingObj.financialInfo },
          passengers: { S: bookingObj.passengers },
          fare: { S: bookingObj.fare },
          ticketDocument: { S: bookingObj.ticketDocument },

          request: { S: bookingObj.request },

          userId: { S: bookingObj.userId },
          userType: { S: bookingObj.userType },

          status: { S: "active" },
          updatedAt: { S: bookingObj.updatedAt }
        }
      });

      await dynamo.send(putCmd);

      if (bookingObj?.bookingReferenceId) {
        updateExpression += ", bookingReferenceId = :bookingReferenceId";
        expressionAttributeValues[":bookingReferenceId"] = {
          S: bookingObj.bookingReferenceId
        };

        const updateCmd = new UpdateItemCommand({
          TableName: process.env.PROV_BOOKING_TABLE,
          Key: { offerId: { S: offerId } },
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues
        });

        await dynamo.send(updateCmd);
        await removedConverationId(authVerification?.context?.userType, searchKey)
      }


    }

    const payload = {
      id: uuidv4(),
      userId: authVerification?.context?.sub,
      userType: authVerification?.context?.userType,
      request: JSON.stringify(body),
      offerId: offerId,
      searchKey: searchKey,
      stepCode: 50,
      status: "active"
    };

    await logTrace(payload)

    const getFlightDetails = new GetItemCommand({
      TableName: process.env.LOG_TRACE_TABLE,
      Key: {
        id: { S: searchKey },
      },
    });
    const flightData = await dynamo.send(getFlightDetails);
    if (!flightData.Item) {
      console.log("No item found");
      return;
    }

    const data = unmarshall(flightData.Item);
    console.log("bookingResponse*******", bookingResponse);

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: process.env.HIGH_DEMAND_BOOKING_QUEUE,
      MessageBody: JSON.stringify(data)
    }));

    const emailData = {
      userId: authVerification?.context?.sub,
      offerId
    }

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: process.env.INVOKE_EMAIL_QUEUE,
      MessageBody: JSON.stringify(emailData),
      DelaySeconds: 300, // 5 minutes
    }));

    console.log("check userId ********", authVerification?.context?.sub);

    return {
      statusCode: 200,
      ...globalHeaders(),
      body: JSON.stringify(bookingResponse),
    };
  } catch (error) {
    return await InternalError(error)
  }
};
