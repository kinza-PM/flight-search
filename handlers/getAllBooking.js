import { globalHeaders, InternalError } from "../helper/helper.js";
import {
    DynamoDBClient,
    ScanCommand,
} from "@aws-sdk/client-dynamodb";

import { unmarshall } from "@aws-sdk/util-dynamodb";
const region = process.env.region
const dynamo = new DynamoDBClient({ region: region });
export const handler = async (event) => {
    try {


        const scanCmd = new ScanCommand({
            TableName: process.env.PROV_BOOKING_TABLE,
        });

        const result = await dynamo.send(scanCmd);

        const items = (result.Items || []).map(item => unmarshall(item));

        return {
            statusCode: 200,
            ...globalHeaders(),
            body: JSON.stringify({
                count: items.Count,
                items: items,
            }),
        };
    } catch (error) {
        return await InternalError(error)
    }
};
