/* Database */
import {MongoClient, GridFSBucket} from 'mongodb';
import process from "node:process";

const HOST = process.env.CRANLIKE_MONGODB_SERVER || '127.0.0.1';
const PORT = process.env.CRANLIKE_MONGODB_PORT || 27017;
const USER = process.env.CRANLIKE_MONGODB_USERNAME || 'root';
const PASS = process.env.CRANLIKE_MONGODB_PASSWORD;
const AUTH = PASS ? (USER + ':' + PASS + "@") : "";
const URL = 'mongodb://' + AUTH + HOST + ':' + PORT;

/* Connect to database */
console.log("Connecting to database....")
export const client = await MongoClient.connect(URL, { useUnifiedTopology: true });
export const db = client.db('cranlike');
export const bucket = new GridFSBucket(db, {bucketName: 'files'});
export const packages = db.collection('packages');
export const chunks = db.collection('files.chunks');
console.log("Connected to MongoDB!");

//removes and recreates all indexes
if(process.env.REBUILD_INDEXES){
  console.log("REBUILDING INDEXES!")
  rebuild_indexes();
}

async function rebuild_indexes(){
  //print (or drop) indexes
  var indexes = await packages.indexes();
  for (let x of indexes) {
    if (x.name == '_id_') continue;
    console.log("Dropping index: " + x.name);
    await packages.dropIndex(x.name).catch(console.log);
  };

  function make_index(query){
    return packages.createIndex(query).then(() => console.log(`Created index: ${JSON.stringify(query)}`));
  }

  /* Speed up common query fields */
  /* NB: Dont use indexes with low cardinality (few unique values) */
  await make_index("Package");
  await make_index("_fileid");
  await make_index("_user");
  await make_index("_published");
  await make_index("_nocasepkg");
  await make_index("_commit.time");
  await make_index("_universes");
  await make_index("_topics");
  await make_index("_exports");
  await make_index({"_universes":1, "_commit.time":1});
  await make_index({"_universes":1, "Package":1});
  await make_index({"_user":1, "_type":1, "Package":1});
  await make_index({"_user":1, "_commit.id":1, "Package":1});
  await make_index({"_user":1, "_type":1, "_commit.time":1});
  await make_index({"_user":1, "_type":1, "_registered":1, "_commit.time":1});
  await make_index({"_type":1, "_rundeps":1});
  await make_index({"_type":1, "_dependencies.package":1});

  /* The text search index (only one is allowed) */
  //await packages.dropIndex("textsearch").catch(console.log);
  await packages.createIndex({
    _type:1,
    Package: "text",
    _owner: "text",
    Title: "text",
    Author: "text",
    Description: "text",
    '_vignettes.title': "text",
    '_vignettes.headings': "text",
    '_maintainer.name': "text",
    '_topics': "text",
    '_sysdeps.name': "text",
    '_exports' : "text",
    '_help.title' : "text",
    '_datasets.title' : "text"
  },{
    weights: {
      Package: 50,
      _owner: 20,
      Title: 5,
      Author: 3,
      Description: 1,
      '_vignettes.title': 5,
      '_vignettes.headings': 2,
      '_maintainer.name': 10,
      '_topics': 10,
      '_sysdeps.name': 20,
      '_exports' : 3,
      '_help.title' : 3,
      '_datasets.title' : 3
    },
    name: "textsearch"
  }).then(() => console.log(`Created index: text-search`));
  var indexes = await packages.indexes();
  console.log(indexes.map(x => x.name));
  console.log("rebuild_indexes complete!")
}


export function get_latest(q){
  return packages.findOne(q, {sort:{_id: -1}, project: {_id: 1, _published: 1, _user: 1, Package: 1}});
}
