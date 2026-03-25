import axios from "axios";
import { getSessionId, globalHeaders } from "../helper/helper.js";
import { v4 as uuidv4 } from "uuid";
import { verifyToken } from "./authorizerLayer.js";
const BASE_URL = process.env.BASE_URL;

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
    const conversationId = uuidv4();

    const { Offers } = body || {};

    // Validate Offers object
    if (!Offers || !Offers.OfferId) {
      throw new Error("Offers.OfferId is required.");
    }

    // Get session ID
    const { sessionId } = await getSessionId();
    if (!sessionId) {
      return {
        statusCode: 500,
        ...globalHeaders(),
        body: JSON.stringify({ message: "Login failed, no sessionId returned." }),
      };
    }

    // Prepare payload
    const moreFaresPayload = {
      Offers: {
        OfferId: Offers.OfferId,
        ResponseParameters: {
          ShopResultPreference: "OPTIMIZED",
        },
      },
    };

    const headers = {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.X_API_KEY,
      conversationId,
      sessionId,
    };

    // API call
    const response = await axios.post(`${BASE_URL}/flight/more-fares`, moreFaresPayload, { headers });

    // Success response
    return {
      statusCode: 200,
      ...globalHeaders(),
      body: JSON.stringify(response.data),
    };
  } catch (error) {
    return await InternalError(error)
  }
};
