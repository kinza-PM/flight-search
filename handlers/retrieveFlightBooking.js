import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { getSessionId, globalHeaders, InternalError, removedConverationId } from "../helper/helper.js";
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

        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body || {};
        // const conversationId = uuidv4();

        const { offerId, searchKey } = body;
        if (!offerId) {
            return {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Credentials": true,
                },
                statusCode: 400,
                body: JSON.stringify({ message: "Missing required field: offerId" }),
            };
        }

        // ✅ Step 4: Obtain sessionId from Provesio
       const { sessionId, conversationId } = await getSessionId(authVerification?.context?.sub, searchKey);
        if (!sessionId) {
            console.error("Failed to obtain sessionId from Provesio API");
            return {
                statusCode: 500,
                ...globalHeaders(),
                body: JSON.stringify({
                    message: "Login failed — no sessionId returned from upstream.",
                }),
            };
        }

        if (!searchKey) {
            console.error("Failed to obtain searchKey from Provesio API");
            return {
                statusCode: 500,
                ...globalHeaders(),
                body: JSON.stringify({
                    message: "Login failed — no searchKey returned from upstream.",
                }),
            };
        }

        if (!conversationId) {
            console.error("Failed to obtain conversationId from Provesio API");
            return {
                statusCode: 500,
                ...globalHeaders(),
                body: JSON.stringify({
                    message: "Login failed — no conversationId returned from upstream.",
                }),
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

        const apiUrl = `${process.env.BASE_URL}/reservation/flight-book-retrieve`;

        console.log("📤 Sending flight booking request to Provesio:", {
            url: apiUrl,
            conversationId,
            offerId
        });

        console.log("body*********", body);

        // ✅ Step 6: Make the API call
        const response = await axios.post(apiUrl, body, axiosConfig);

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

        console.log("response.data********", JSON.stringify(response.data, null, 2));

        await removedConverationId(authVerification?.context?.sub, searchKey)

        // ✅ Step 8: Return success
        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify(response.data),
        };
    } catch (error) {
        return await InternalError(error)
    }
};
