/* Database */
const assert = require('assert');
const mongodb = require('mongodb');
const HOST = process.env.CRANLIKE_MONGODB_SERVER || '127.0.0.1';
const PORT = process.env.CRANLIKE_MONGODB_PORT || 27017;
const USER = process.env.CRANLIKE_MONGODB_USERNAME || 'root';
const PASS = process.env.CRANLIKE_MONGODB_PASSWORD;
const AUTH = PASS ? (USER + ':' + PASS + "@") : "";
const URL = 'mongodb://' + AUTH + HOST + ':' + PORT;

/* Connect to database */
console.log("Connecting to database....")
const connection = mongodb.MongoClient.connect(URL, {useUnifiedTopology: true});
connection.then(async function(client) {
  console.log("Connected to MongoDB!")
  const db = client.db('cranlike');
  //console.log(client)
  //console.log(db)
  global.bucket = new mongodb.GridFSBucket(db, {bucketName: 'files'});
  global.packages = db.collection('packages');
  global.chunks = db.collection('files.chunks');

  /* Speed up common query fields */
  /* NB: Dont use indexes with low cardinality (few unique values) */
  await packages.createIndex("MD5sum");
  await packages.createIndex("_user");
  await packages.createIndex("_published");
  await packages.createIndex("_builder.commit.time");
  await packages.createIndex("_builder.maintainer.login");
  await packages.createIndex({"_user":1, "_type":1, "Package":1});
  await packages.createIndex({"_user":1, "_builder.commit.id":1, "Package":1});
  await packages.createIndex({"_user":1, "_type":1, "_builder.commit.time":1});
  await packages.createIndex({"_user":1, "_type":1, "_registered":1, "_builder.commit.time":1});
  await packages.createIndex({"_builder.maintainer.login":1, "_selfowned":1, "_builder.commit.time":1});

  /* The text search index (only one is allowed) */
  //await packages.dropIndex("textsearch").catch(console.log);
  await packages.createIndex({
    _type:1,
    Package: "text",
    _owner: "text",
    Title: "text",
    Author: "text",
    Description: "text",
    '_contents.vignettes.title': "text",
    '_builder.maintainer.name': "text",
    '_contents.gitstats.topics': "text",
    '_contents.sysdeps.name': "text",
    '_contents.exports' : "text",
    '_contents.help.title' : "text",
    '_contents.datasets.title' : "text"
  },{
    weights: {
      Package: 50,
      _owner: 20,
      Title: 5,
      Author: 3,
      Description: 1,
      '_contents.vignettes.title': 5,
      '_builder.maintainer.name': 10,
      '_contents.gitstats.topics': 10,
      '_contents.sysdeps.name': 20,
      '_contents.exports' : 3,
      '_contents.help.title' : 3,
      '_contents.datasets.title' : 3
    },
    name: "textsearch"
  });

  //await packages.dropIndex("_user_1__type_1__registered_1").catch(console.log);
  packages.indexes().then(function(x){
    //console.log("Current indexes() for packages:")
    //console.log(x);
  });
}).catch(function(error){
  console.log("Failed to connect to mongodb!\n" + error)
  throw error;
});

module.exports = connection;
