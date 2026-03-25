import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import { globalHeaders } from "../helper/helper.js";

const region = process.env.region;
const s3 = new S3Client({ region });

export const handler = async (event) => {
  try {
    const { offerId, contentType } = JSON.parse(event.body);

    if (!offerId || !contentType) {
      return {
        ...globalHeaders(),
        statusCode: 400,
        body: JSON.stringify({ message: "offerId and contentType are required" }),
      };
    }

    const fileKey = `tickets/${offerId}/${uuidv4()}`; // unique S3 key

    const command = new PutObjectCommand({
      Bucket: process.env.BOOKED_TICKET_BUCKET,
      Key: fileKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 minutes

    return {
      statusCode: 200,
      ...globalHeaders(),
      body: JSON.stringify({
        uploadUrl,  // Frontend uses this to upload the image
        fileKey,    // Save this key in DB to reference the ticket
      }),
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal Server Error" }),
    };
  }
};
