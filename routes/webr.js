const express = require('express');
const createError = require('http-errors');
const webr = require("@r-wasm/webr");
const router = express.Router();
const tools = require("../src/tools.js");

/* Start webr and download some packages */
const session = new webr.WebR();
session.init().then(function(){
  return session.installPackages(['jsonlite', 'writexl']);
}).then(function(){
  console.log("webR is ready!");
}).catch(function(e){
  console.log("ERROR: problem starting webr! " + e);
});

function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

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
        await session.evalRVoid(`utils::write.csv(${key}$${name}, "${key}.out", row.names=FALSE)`)
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.attachment(`${name}.csv`).send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'rda') {
        await session.evalRVoid(`save(${name}, envir=${key}, file="${key}.out")`);
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.attachment(`${name}.RData`).send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'rds') {
        await session.evalRVoid(`saveRDS(${key}$${name}, file="${key}.out")`);
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.attachment(`${name}.rds`).send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'json') {
        var out = await session.evalR(`jsonlite::toJSON(${key}$${name})`);
        var jsontxt = await out.toString();
        session.destroy(out);
        res.type("application/json").send(jsontxt);
      } else if(format == 'ndjson') {
        var out = await session.evalRVoid(`jsonlite::stream_out(${key}$${name}, file("${key}.out"))`);
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.type("text/plain").send(Buffer.from(outbuf, 'binary'));
      } else if(format == 'xlsx') {
        var out = await session.evalRVoid(`writexl::write_xlsx(${key}$${name}, "${key}.out")`);
        var outbuf = await session.FS.readFile(`${key}.out`);
        res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment(`${name}.xslx`).send(Buffer.from(outbuf, 'binary'));
      } else {
        throw "Only csv, json, xlsx, rda format is supported";
      }
    }
  }).catch(error_cb(400, next)).finally(function(){
    session.evalRVoid(`unlink(c('${key}.rdx', '${key}.rdb', '${key}.out'))`);
    session.evalRVoid(`rm(${key})`);
    //session.close();
  });
});

module.exports = router;
