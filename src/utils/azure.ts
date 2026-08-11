import { Request, Response } from "express";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import catchAsync from "./catchAsync";
import { sendResponse } from "./response";

// @types/multer already augments Express.Request with `file`/`files`; the
// local re-declaration referenced a `MulterFile` export that does not exist.

// Azure Blob Storage configuration
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME as string;
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY as string;
const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING as string;
const containerName = process.env.AZURE_CONTAINER_NAME as string;

/**
 * Built on first use, not at module load. Constructing the credential eagerly
 * threw on `new StorageSharedKeyCredential(undefined, undefined)` whenever the
 * Azure vars were unset — which crashed the entire server at boot, including
 * routes that have nothing to do with file uploads.
 *
 * Now an upload attempt without configuration fails that one request, and
 * everything else starts normally.
 */
let _blobServiceClient: BlobServiceClient | null = null;

const getBlobServiceClient = (): BlobServiceClient => {
  if (_blobServiceClient) return _blobServiceClient;

  if (connectionString) {
    _blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  } else {
    if (!accountName || !accountKey) {
      throw new Error(
        'Azure storage is not configured (set AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY)'
      );
    }
    _blobServiceClient = new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      new StorageSharedKeyCredential(accountName, accountKey)
    );
  }
  return _blobServiceClient;
};

// Initialize container function
const initializeContainer = async () => {
  try {
    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    const containerExists = await containerClient.exists();
    
    if (!containerExists) {
      console.log(`Creating container: ${containerName}`);
      await containerClient.create({
        access: 'blob' // Make container public for blob access
      });
      console.log(`Container created successfully: ${containerName}`);
    } else {
      console.log(`Container already exists: ${containerName}`);
    }
    
    // Ensure container has proper access level
    try {
      await containerClient.setAccessPolicy('blob');
      console.log(`Container access policy set to blob for: ${containerName}`);
    } catch (error) {
      console.warn('Could not set access policy:', error);
    }
  } catch (error) {
    console.error('Error initializing container:', error);
  }
};

// Initialize container on startup
initializeContainer();

// Generate unique ID for file names
const generateUniqueId = (): string => {
  const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const timestamp = Date.now().toString();
  const randomCharsLength = 10;
  const halfLength = Math.floor((randomCharsLength - timestamp.length) / 2);

  const randomChars1 = Array.from({ length: halfLength }, () => characters[Math.floor(Math.random() * characters.length)]).join('');
  const randomChars2 = Array.from({ length: randomCharsLength - halfLength - timestamp.length }, () => characters[Math.floor(Math.random() * characters.length)]).join('');

  return randomChars1 + timestamp + randomChars2;
};

// Upload document to Azure Blob Storage
export const uploadDocumentToAzure = catchAsync(async (req: Request, res: Response) => {
  try {
    // Ensure file is available
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // Extract file from request body
    const file = req.file;
    
    // Generate unique filename
    const fileName = `${generateUniqueId()}-${file.originalname}`;
    
    // Get container client
    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    
    // Ensure container exists and create if it doesn't
    const containerExists = await containerClient.exists();
    if (!containerExists) {
      console.log(`Creating container: ${containerName}`);
      await containerClient.create({
        access: 'blob' // Make container public for blob access
      });
      // Set access policy to ensure public access
      await containerClient.setAccessPolicy('blob');
    }
    
    // Get blob client
    const blobClient = containerClient.getBlockBlobClient(fileName);
    
    // Upload file buffer to Azure Blob Storage
    const uploadBlobResponse = await blobClient.uploadData(file.buffer, {
      blobHTTPHeaders: {
        blobContentType: file.mimetype,
      },
    });

    // Use blob client URL instead of manually constructing it
    const url = blobClient.url;
    
    // Verify the blob exists
    const blobExists = await blobClient.exists();
    sendResponse(res, 200, 'Document uploaded successfully', { 
      url,
      fileName,
      size: file.size,
      mimetype: file.mimetype,
      blobExists,
      uploadResponse: {
        requestId: uploadBlobResponse.requestId,
        version: uploadBlobResponse.version,
        date: uploadBlobResponse.date
      }
    });

  } catch (error) {
    console.error('Error uploading document to Azure:', error);
    console.error('Error details:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to upload document to Azure',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Debug function to list containers
export const listContainers = catchAsync(async (req: Request, res: Response) => {
  try {
    const containers = [];
    for await (const container of getBlobServiceClient().listContainers()) {
      containers.push(container.name);
    }
    
    sendResponse(res, 200, 'Containers listed successfully', { containers });
  } catch (error) {
    console.error('Error listing containers:', error);
    res.status(500).json({ success: false, error: 'Failed to list containers' });
  }
});

// Debug function to list blobs in the container
export const listBlobs = catchAsync(async (req: Request, res: Response) => {
  try {
    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    const blobs = [];
    
    for await (const blob of containerClient.listBlobsFlat()) {
      blobs.push({
        name: blob.name,
        url: `https://${accountName}.blob.core.windows.net/${containerName}/${blob.name}`,
        size: blob.properties.contentLength,
        lastModified: blob.properties.lastModified,
        contentType: blob.properties.contentType
      });
    }
    
    sendResponse(res, 200, 'Blobs listed successfully', { blobs, containerName });
  } catch (error) {
    console.error('Error listing blobs:', error);
    res.status(500).json({ success: false, error: 'Failed to list blobs' });
  }
});

// Function to decode Azure Blob Storage URL
export const decodeAzureBlobUrl = catchAsync(async (req: Request, res: Response) => {
  try {
    const { encodedUrl } = req.body;
    
    if (!encodedUrl) {
      return res.status(400).json({ success: false, error: 'encodedUrl is required in request body' });
    }

    // Decode the URL
    const decodedUrl = decodeURIComponent(encodedUrl);
    
    // Extract parts from the URL for additional info
    const urlParts = decodedUrl.split('/');
    const fileName = urlParts[urlParts.length - 1];
    const containerName = urlParts[urlParts.length - 2];
    const accountName = urlParts[2].split('.')[0];
    
    // Verify if the blob exists (optional verification)
    let blobExists = false;
    try {
      const containerClient = getBlobServiceClient().getContainerClient(containerName);
      const blobClient = containerClient.getBlockBlobClient(fileName);
      blobExists = await blobClient.exists();
    } catch (error) {
      console.warn('Could not verify blob existence:', error);
    }
    
    sendResponse(res, 200, 'URL decoded successfully', {
      originalUrl: encodedUrl,
      decodedUrl: decodedUrl,
      fileName: fileName,
      containerName: containerName,
      accountName: accountName,
      blobExists: blobExists
    });

  } catch (error) {
    console.error('Error decoding Azure Blob URL:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to decode Azure Blob URL',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Function to encode Azure Blob Storage URL
export const encodeAzureBlobUrl = catchAsync(async (req: Request, res: Response) => {
  try {
    const { decodedUrl } = req.body;
    
    if (!decodedUrl) {
      return res.status(400).json({ success: false, error: 'decodedUrl is required in request body' });
    }

    // Encode the URL
    const encodedUrl = encodeURIComponent(decodedUrl);
    
    sendResponse(res, 200, 'URL encoded successfully', {
      originalUrl: decodedUrl,
      encodedUrl: encodedUrl
    });

  } catch (error) {
    console.error('Error encoding Azure Blob URL:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to encode Azure Blob URL',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Function to get properly formatted Azure Blob URL
export const getAzureBlobUrl = catchAsync(async (req: Request, res: Response) => {
  try {
    const { fileName, containerName: reqContainerName } = req.body;
    
    if (!fileName) {
      return res.status(400).json({ success: false, error: 'fileName is required in request body' });
    }

    // Use provided container name or default to environment variable
    const targetContainer = reqContainerName || containerName;
    
    // Create the blob URL
    const containerClient = getBlobServiceClient().getContainerClient(targetContainer);
    const blobClient = containerClient.getBlockBlobClient(fileName);
    
    // Get the blob URL
    const blobUrl = blobClient.url;
    
    // Check if blob exists
    const blobExists = await blobClient.exists();
    
    // Get blob properties if it exists
    let blobProperties = null;
    if (blobExists) {
      try {
        const properties = await blobClient.getProperties();
        blobProperties = {
          contentLength: properties.contentLength,
          contentType: properties.contentType,
          lastModified: properties.lastModified,
          etag: properties.etag
        };
      } catch (error) {
        console.warn('Could not get blob properties:', error);
      }
    }
    
    sendResponse(res, 200, 'Azure Blob URL generated successfully', {
      fileName: fileName,
      containerName: targetContainer,
      blobUrl: blobUrl,
      blobExists: blobExists,
      blobProperties: blobProperties
    });

  } catch (error) {
    console.error('Error generating Azure Blob URL:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate Azure Blob URL',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Function to check and set container access policy
export const setContainerAccessPolicy = catchAsync(async (req: Request, res: Response) => {
  try {
    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    
    // Check if container exists
    const containerExists = await containerClient.exists();
    if (!containerExists) {
      return res.status(404).json({ success: false, error: 'Container does not exist' });
    }
    
    // Set access policy to blob (public access)
    await containerClient.setAccessPolicy('blob');
    
    // Get current access policy to verify
    const accessPolicy = await containerClient.getAccessPolicy();
    
    sendResponse(res, 200, 'Container access policy set successfully', {
      containerName,
      message: 'Access policy set to blob (public access)'
    });
  } catch (error) {
    console.error('Error setting container access policy:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to set container access policy',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Function to get container properties and access policy
export const getContainerInfo = catchAsync(async (req: Request, res: Response) => {
  try {
    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    
    // Check if container exists
    const containerExists = await containerClient.exists();
    if (!containerExists) {
      return res.status(404).json({ success: false, error: 'Container does not exist' });
    }
    
    // Get container properties
    const properties = await containerClient.getProperties();
    
    // Get access policy
    const accessPolicy = await containerClient.getAccessPolicy();
    
    sendResponse(res, 200, 'Container information retrieved successfully', {
      containerName,
      exists: containerExists,
      properties: {
        lastModified: properties.lastModified,
        etag: properties.etag,
        publicAccess: properties.blobPublicAccess
      },
      message: 'Container with blob access policy'
    });
  } catch (error) {
    console.error('Error getting container info:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get container info',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Function to test blob accessibility
export const testBlobAccess = catchAsync(async (req: Request, res: Response) => {
  try {
    const { fileName } = req.body;
    
    if (!fileName) {
      return res.status(400).json({ success: false, error: 'fileName is required in request body' });
    }
    
    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    const blobClient = containerClient.getBlockBlobClient(fileName);
    
    // Check if blob exists
    const blobExists = await blobClient.exists();
    
    if (!blobExists) {
      return res.status(404).json({ success: false, error: 'Blob not found' });
    }
    
    // Get blob properties
    const properties = await blobClient.getProperties();
    
    // Generate the URL
    const url = blobClient.url;
    
    // Try to download the blob to verify accessibility
    let downloadSuccess = false;
    try {
      const downloadResponse = await blobClient.download(0);
      downloadSuccess = true;
    } catch (error) {
      console.error('Error downloading blob:', error);
    }
    
    sendResponse(res, 200, 'Blob access test completed', {
      fileName,
      blobExists,
      downloadSuccess,
      url,
      properties: {
        contentLength: properties.contentLength,
        contentType: properties.contentType,
        lastModified: properties.lastModified,
        etag: properties.etag
      }
    });
  } catch (error) {
    console.error('Error testing blob access:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to test blob access',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});
