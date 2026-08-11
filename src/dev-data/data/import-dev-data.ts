import * as fs from 'fs';
import mongoose from 'mongoose';
// import * as dotenv from 'dotenv';
// import AddressModel from '../../models/address/addressModel';

// dotenv.config({ path: '../../../.env' });
const DB: string = 'mongodb+srv://biswaruprx21:PG11lal6xMOE1FqI@cluster1.dvfjtgc.mongodb.net/maple_tree_tax?retryWrites=true&w=majority&appName=Cluster1'

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

