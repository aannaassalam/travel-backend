import express from 'express';
import { uploadDocumentToPublicAWS } from '../../utils/aws';
import { 
  uploadDocumentToAzure, 
  listContainers, 
  listBlobs, 
  decodeAzureBlobUrl, 
  encodeAzureBlobUrl, 
  getAzureBlobUrl,
  setContainerAccessPolicy,
  getContainerInfo,
  testBlobAccess
} from '../../utils/azure';
import { protect } from '../../controllers/authController';
import upload from '../../utils/multerConfig';
const router = express.Router();
router.use(protect); // Protect all routes in this router
// Route to handle file upload to AWS
router.post('/upload-to-aws', upload.single('file'), uploadDocumentToPublicAWS);

// Route to handle file upload to Azure
router.post('/upload-to-azure', upload.single('file'), uploadDocumentToAzure);

// Debug routes for Azure
router.get('/azure-containers', listContainers);
router.get('/azure-blobs', listBlobs);
router.get('/azure-container-info', getContainerInfo);
router.post('/azure-set-access-policy', setContainerAccessPolicy);
router.post('/azure-test-blob-access', testBlobAccess);

// URL utility routes for Azure
router.post('/decode-azure-url', decodeAzureBlobUrl);
router.post('/encode-azure-url', encodeAzureBlobUrl);
router.post('/get-azure-url', getAzureBlobUrl);

// Export the router
export default router;