
import multer from 'multer';

// Multer configuration for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

export default upload;