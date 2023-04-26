const express = require('express');
const createError = require('http-errors');
const webr = require("@r-wasm/webr");
const router = express.Router();
const tools = require("../src/tools.js");
const session = new webr.WebR();
session.init();

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
      } else {
        throw "Only csv and rda format is supported for now";
      }
    }
  }).catch(error_cb(400, next)).finally(function(){
    session.evalR(`unlink(c('${key}.rdx', '${key}.rdb', '${key}.out'))`);
    session.evalR(`rm(${key})`);
    //session.close();
  });
});

module.exports = router;
