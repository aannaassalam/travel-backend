



add dev data to db-
1. update the db url in the import-dev-data.ts file.
2. check the require json files 
3. convert import-dev-data.ts to import-dev-data.js 
          run ->  (npx tsc src/dev-data/data/import-dev-data.ts)
4. run -> node src/dev-data/data/import-dev-data.js --import
          node src/dev-data/data/import-dev-data.js --delete

5. at the end remove the js files from models