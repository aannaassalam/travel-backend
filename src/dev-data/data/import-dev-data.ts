import * as fs from 'fs';
import mongoose from 'mongoose';
// import * as dotenv from 'dotenv';
// import AddressModel from '../../models/address/addressModel';

// dotenv.config({ path: '../../../.env' });
// §BUG-004: never commit credentials. Read the same env var the app connects
// with (see src/config/db.config.ts). The compromised literal that was here must
// be rotated on the Atlas cluster — removing it from source does not revoke it.
const DB: string = process.env.MONGODB_URI || ''

mongoose
  .connect(DB)
  .then(() => console.log('DB connection established!'))
  .catch((error) => {
    throw new Error(error.message);
  });

// Define types for JSON data
type AddressData = any[]; // Update with your actual type
// READ JSON files
const address: AddressData = JSON.parse(
  fs.readFileSync(`${__dirname}/addresses.json`, 'utf8')
);

// IMPORT DATA INTO DB
const importData = async () => {
  try {
    // await AddressModel.create(address);
    
    console.log('Data successfully loaded into database!');
  } catch (err) {
    console.log(err);
  }
  process.exit();
};

// DELETE DATA FROM DB
const deleteData = async () => {
  try {
    // await AddressModel.deleteMany();
    console.log('Data successfully deleted!');
    process.exit();
  } catch (err) {
    console.log(err);
  }
};

if (process.argv[2] === '--import') {
  importData();
} else if (process.argv[2] === '--delete') {
  deleteData();
}

