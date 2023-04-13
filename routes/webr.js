const express = require('express');
const createError = require('http-errors');
const webr = require("@r-wasm/webr");
const router = express.Router();
const tools = require("../src/tools.js");

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
  var session = new webr.WebR();
  return packages.findOne(query).then(async function(x){
    var datasets = x['_contents'] && x['_contents'].datasets || [];
    if(!name) {
      return res.send(datasets);
    } else {
      if(!format){
        return res.redirect(req.path.replace(/\/$/, '') + '/csv');
      }
      if(format != 'csv')
        throw "Only csv format is supported for now";
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
      await session.FS.writeFile('Rdata.rdx', rdx);
      await session.FS.writeFile('Rdata.rdb', rdb);
      await session.evalR(`lazyLoad('Rdata', filter = function(x) x=='${name}')`);
      await session.evalR(`write.csv(${name}, "output.csv")`)
      var csvdata = await session.FS.readFile("output.csv");
      res.attachment(`${name}.csv`).send(Buffer.from(csvdata, 'binary'));
    }
  }).catch(error_cb(400, next)).finally(function(){
    session.close();
  });
});

module.exports = router;
