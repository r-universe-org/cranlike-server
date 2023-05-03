const express = require('express');
const createError = require('http-errors');
const webr = require("@r-universe/webr");
const router = express.Router();
const tools = require("../src/tools.js");

/* Start webr and download some packages */
var session;
function reset_webr(){
  if(session) session.close();
  session = new webr.WebR();
  session.started = new Date();
  session.init().then(function(){
    console.log("webR is ready!");
  }).catch(function(e){
    console.log("ERROR: problem starting webr! " + e);
  });
}

reset_webr();

router.get('/:user/:package/data/:name?/:format?', function(req, res, next){
  var user =  req.params.user;
  var package = req.params.package;
  var name = req.params.name;
  var format = req.params.format;
  var query = {'_user': user, 'Package': package, '_type': 'src'};
  var key = `${package}_${name}`.replace(/\W+/g, "");
  return packages.findOne(query).then(async function(x){
    var datasets = x['_contents'] && x['_contents'].datasets || [];
    if(!name) {
      return res.send(datasets);
    } else {
      if(!format){
        return res.redirect(req.path.replace(/\/$/, '') + '/csv');
      }
      var ds = datasets.find(x => x.name == name);
      if(!ds)
        throw `No data "${name}" found in ${package}`;
      var files = [`${package}/data/Rdata.rdb`, `${package}/data/Rdata.rdx`];
      query['_type'] = {'$in' : ['mac', 'linux']}
      var buffers = await tools.get_extracted_file(query, files);
      if(!buffers[0] || !buffers[1])
        throw "Failed to load Rdata.rdb/dbx";
      var rdb = new Uint8Array(buffers[0]);
      var rdx = new Uint8Array(buffers[1]);
      await session.init();
      await session.FS.writeFile(`${key}.rdx`, rdx);
      await session.FS.writeFile(`${key}.rdb`, rdb);
      await session.evalRVoid(`${key} <- new.env()`);
      await session.evalRVoid(`lazyLoad('${key}', envir=${key}, filter=function(x) x=='${name}')`);
      if(format == 'csv'){
        await session.evalRVoid(`data.table::fwrite(${key}$${name}, "${key}.out")`)
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.attachment(`${name}.csv`).send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'csv.gz'){
        await session.evalRVoid(`data.table::fwrite(${key}$${name}, "${key}.out", compress='gzip')`)
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.attachment(`${name}.csv.gz`).send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'rda') {
        await session.evalRVoid(`save(${name}, envir=${key}, file="${key}.out")`);
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.attachment(`${name}.RData`).send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'rds') {
        await session.evalRVoid(`saveRDS(${key}$${name}, file="${key}.out")`);
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.attachment(`${name}.rds`).send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'json') {
        await session.evalRVoid(`jsonlite::write_json(${key}$${name}, "${key}.out")`);
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.type("application/json").send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'ndjson') {
        await session.evalRVoid(`jsonlite::stream_out(${key}$${name}, file("${key}.out"), verbose=FALSE)`);
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.type("text/plain").send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'xlsx') {
        await session.evalRVoid(`writexl::write_xlsx(${key}$${name}, "${key}.out")`);
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment(`${name}.xlsx`).send(Buffer.from(outbuf, 'binary'));
      } else {
        throw "Only csv, json, xlsx, rda format is supported";
      }
    }
  }).catch(function(err){
    next(createError(400, err));
    const now = new Date();
    if(err.stack && (now - session.started > 60000)){
      console.log("Got an R error. Restarting R...")
      reset_webr(); //restart for R errors, but at most once per minute
    }
  }).finally(function(){
    session.evalRVoid(`unlink(c('${key}.rdx', '${key}.rdb', '${key}.out'))`);
    session.evalRVoid(`rm(${key})`);
  });
});

module.exports = router;
