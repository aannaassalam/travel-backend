import { Request, Response } from "express";
import catchAsync from "./catchAsync";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sendResponse } from "./response";
// @types/multer already augments Express.Request with `file`/`files`; the
// local re-declaration referenced a `MulterFile` export that does not exist.
// aws setup
// AWS setup with proper type casting to ensure non-undefined credentials
const s3 = new S3Client({
    region: process.env.AWS_REGION as string,  // Ensuring that the region is of type string
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,  // Casting to string to avoid the undefined error
      secretAccessKey: process.env.AWS_ACCESS_KEY_SECRET as string,  // Casting to string to avoid the undefined error
    },
  });
const publicBucketName = process.env.AWS_PUBLIC_BUCKET_NAME; // Specify your bucket name
const generateUniqueId = (): string => {
  const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const timestamp = Date.now().toString();
  const randomCharsLength = 10;
  const halfLength = Math.floor((randomCharsLength - timestamp.length) / 2);

  const randomChars1 = Array.from({ length: halfLength }, () => characters[Math.floor(Math.random() * characters.length)]).join('');
  const randomChars2 = Array.from({ length: randomCharsLength - halfLength - timestamp.length }, () => characters[Math.floor(Math.random() * characters.length)]).join('');

  return randomChars1 + timestamp + randomChars2;
};

export const uploadDocumentToPublicAWS=catchAsync(async (req: Request, res: Response) => {
    try {
      // Ensure file is available
  
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
      }
  
      // Extract file from request body
      const file = req.file;
      //change file name to a unique name using uuid
      const fileName = `${generateUniqueId()}-${file.originalname}`;
      // Upload file to S3 bucket
      const params = {
        Bucket: publicBucketName, // Replace with your bucket name
        Key: fileName,
        Body: file.buffer,
        // ACL: 'public-read'
      };
      
      const command = new PutObjectCommand(params);
      
      await s3.send(command);
      // get public url for the uploaded file
    const url = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`;
      sendResponse(res, 200, 'Document uploaded successfully', { url });
} catch (error) {
      console.error('Error uploading document:', error);
      res.status(500).json({ success: false, error: 'Failed to upload document' });
    }
  })