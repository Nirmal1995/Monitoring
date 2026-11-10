// Runs once, on the first start with an empty data volume
// (official image /docker-entrypoint-initdb.d mechanism).
// Creates the least-privilege application user, with readWrite on the
// application database and on a separate "<db>_test" database used by the
// integration tests (so tests never touch development data).
const dbName = process.env.MONGO_APP_DATABASE;
const user = process.env.MONGO_APP_USERNAME;
const pwd = process.env.MONGO_APP_PASSWORD;

if (!dbName || !user || !pwd) {
  throw new Error('MONGO_APP_DATABASE, MONGO_APP_USERNAME and MONGO_APP_PASSWORD must be set');
}

const roles = [
  { role: 'readWrite', db: dbName },
  { role: 'readWrite', db: `${dbName}_test` },
];

const appDb = db.getSiblingDB(dbName);
if (appDb.getUser(user)) {
  appDb.grantRolesToUser(user, roles);
  print(`[streamhub] user ${user} already exists, roles ensured`);
} else {
  appDb.createUser({ user, pwd, roles });
  print(`[streamhub] created user ${user} with readWrite on ${dbName} and ${dbName}_test`);
}
