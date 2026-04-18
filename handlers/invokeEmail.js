import axios from "axios";
import { getSessionId, globalHeaders, InternalError } from "../helper/helper.js";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
    DynamoDBClient,
    QueryCommand,
    GetItemCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
const region = process.env.REGION
const dynamo = new DynamoDBClient({ region: region });
const sqsClient = new SQSClient({
    region: region,
});


export const handler = async (event, context) => {
    try {
        const requestId = context.awsRequestId
        console.log("AWS Request ID:", requestId);
        for (const record of event.Records) {
            const { userId, offerId } = JSON.parse(record.body)
            console.log("userId***********", userId);
            console.log("offerId***********", offerId);

            const getUserDetails = new QueryCommand({
                TableName: process.env.USERS_TABLE,
                KeyConditionExpression: "userId = :uid",
                ExpressionAttributeValues: {
                    ":uid": { S: userId },
                },
                Limit: 1,
            });

            const userData = await dynamo.send(getUserDetails);
            const userDetails = unmarshall(userData.Items[0]);

            console.log("userDetails******", userDetails);

            const command = new GetItemCommand({
                TableName: process.env.PROV_BOOKING_TABLE, // replace with your table name
                Key: {
                    offerId: { S: offerId } // partition key must match type
                }
            });


            const provBookingRes = await dynamo.send(command);
            const provBookingDetails = unmarshall(provBookingRes.Item);
            console.log("provBookingDetails*******", provBookingDetails);

            const getFlightJourneyDetails = new QueryCommand({
                TableName: process.env.LOG_TRACE_TABLE,
                IndexName: "GSI_Offer_Step",
                KeyConditionExpression: "offerId = :offerId AND stepCode = :stepCode",
                ExpressionAttributeValues: {
                    ":offerId": { S: offerId },
                    ":stepCode": { N: "40" }
                },
                Limit: 1
            });

            const getFlightJourneyDetailsData = await dynamo.send(getFlightJourneyDetails);

            const item = getFlightJourneyDetailsData.Items[0];
            if (!item) {
                console.log("No items found for offerId", offerId);
                return;
            }

            // Unmarshall DynamoDB item
            const data = unmarshall(item);
            console.log(`[${requestId}] typeof data.request:`, typeof data.request);

            let requestObj =
                typeof data.request === "string"
                    ? JSON.parse(data.request)
                    : data.request;
            console.log("requestObj*********", requestObj);

            // If still string, parse again
            if (typeof requestObj === "string") {
                requestObj = JSON.parse(requestObj);
            }

            console.log("requestObj*******", JSON.stringify(requestObj, null, 2));
            const journey = requestObj?.journey || [];
            const passengers = requestObj?.passengers || [];
            const flightSegment = journey[0].flightSegments
            const fareDetails = typeof provBookingDetails?.fare === 'string' ? JSON.parse(provBookingDetails?.fare) : provBookingDetails?.fare;
            const flightDetails = [];
            const passengerNames = [];
            const passengersFares = [];
            const taxFees = [];
            console.log("fareDetails*******", JSON.stringify(fareDetails, null, 2));

            for (let i = 0; i < flightSegment.length; i++) {
                let departureAirportCode = flightSegment[i].departureAirportCode
                let arrivalAirportCode = flightSegment[i].arrivalAirportCode
                let departureDateTime = flightSegment[i].departureDateTime
                let arrivalDateTime = flightSegment[i].arrivalDateTime

                const flightDetailsObj = {
                    flightFrom: await queryByIata(departureAirportCode),
                    flightTo: await queryByIata(arrivalAirportCode),
                    flightFromCode: departureAirportCode,
                    flightToCode: arrivalAirportCode,
                    flightName: flightSegment[i].marketingAirline,
                    flightNumber: flightSegment[i].flightNumber,
                    cabinClass: flightSegment[i].cabinClass,
                    departureDateTime: departureDateTime,
                    arrivalDateTime: arrivalDateTime,
                    duration: flightSegment[i].duration,
                    layoverTime: flightSegment[i].layoverTime,
                }
                flightDetails.push(flightDetailsObj)
            }

            console.log("passenger data *********", JSON.stringify(passengers, null, 2));

            for (let i = 0; i < passengers.length; i++) {
                let nameTitle = passengers[i].passengerInfo.nameTitle
                let givenName = passengers[i].passengerInfo.givenName
                let travelName = `${nameTitle} ${givenName}`
                passengerNames.push(travelName)
            }

            for (let i = 0; i < fareDetails?.fareBreakdown?.length; i++) {
                let noOfPassengers = fareDetails?.fareBreakdown[i].passengerKeys.length;
                let taxes = fareDetails?.fareBreakdown[i].paxRate.taxes;
                let fares = {
                    paxType: fareDetails?.fareBreakdown[i].paxType,
                    noOfPassengers,
                    totalFare: fareDetails?.fareBreakdown[i].paxRate.totalFare * noOfPassengers,
                }
                passengersFares.push(fares)
                taxFees.push(...taxes)
            }


            const emailData = {
                username: userDetails?.name,
                bookingReferenceId: provBookingDetails?.bookingReferenceId,
                email: userDetails?.email,
                flightDetails,
                passengerNames: passengerNames,
                passengersFares: passengersFares,
                taxFees,
                totalFare: fareDetails?.totalFare,
                ticketImage: null
            }
            console.log("passengerNames************", passengerNames);

            console.log(JSON.stringify(emailData, null, 2));
            await sqsClient.send(new SendMessageCommand({
                QueueUrl: process.env.SEND_EMAIL_QUEUE,
                MessageBody: JSON.stringify(emailData)
            }));
        }

        return {
            statusCode: 200,
            ...globalHeaders(),
            // body: JSON.stringify(response.data),
        };
    } catch (error) {
        console.log("error*********", error);

        return await InternalError(error)
    }
};

async function queryByIata(iataCode) {
    console.log("iataCode*********", iataCode);

    if (!iataCode) throw new Error("iataCode is undefined");

    const params = {
        TableName: process.env.COUNTRIES_LISTING_TABLE,
        IndexName: "GSI_IATA_CODE",
        KeyConditionExpression: "iataCode = :iata",
        ExpressionAttributeValues: {
            ":iata": { S: iataCode },
        },
    };

    const result = await dynamo.send(new QueryCommand(params));
    return result.Items[0].city.S;
}