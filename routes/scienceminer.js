const template = '{"fields":["_id","labels","authors","authors","licenses","collection","programming_language_class","organizations","date","number_mentions","number_documents","number_software","descriptions","summary"],"_source":false,"track_total_hits":true,"query":{"bool":{"should":[],"must":[{"query_string":{"fields":["labels"],"query":"rcpp","default_operator":"AND"}}],"must_not":[],"filter":{"bool":{"must":[{"term":{"programming_language_class":"R"}},{"term":{"collection":"software"}}]}}}},"sort":[{"number_documents":{"order":"desc"}}],"size":12,"aggs":{"Entity":{"terms":{"field":"collection","size":60,"order":{"_count":"desc"}}},"Author":{"terms":{"field":"authors_full","size":60,"order":{"_count":"desc"}}},"Languages":{"terms":{"field":"programming_language_class","size":60,"order":{"_count":"desc"}}}},"highlight":{"fields":{"labels":{"fragment_size":130,"number_of_fragments":3}},"order":"score","pre_tags":["<strong>"],"post_tags":["</strong>"],"require_field_match":true}}';
var express = require('express');
var createError = require('http-errors');
var router = express.Router();

function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

function find_package(package){
  const url = 'https://cloud.science-miner.com/software_kb/search/software-kb/_search';
  var payload = JSON.parse(template);
  payload.query.bool.must[0].query_string.query = package;
  return fetch(url,{
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  }).then(function(response){
    var data = response.json();
    data.status = response.status;
    return data;
  }).then(function(res){
    var total = res.hits.total.value;
    if(total < 1){
      throw `No entry found for R package ${package} not found`;
    }
    if(total > 1){
      console.log(`ScienceMiner found more than 1 package found for ${package} (using first hit).`);
    }
    var data = res.hits.hits[0];
    data.weburl = `https://cloud.science-miner.com/software_kb/frontend/mentions.html?id=${data['_id']}`;
    return data;
  }).catch(data => {
    throw `${data.message || data} (HTTP ${data.status})`;
  });
}

function find_mentions(id, max = 1000){
  url = `https://cloud.science-miner.com/software_kb/entities/software/${id}/mentions?page_rank=0&page_size=${max}&ranker=count`;
  return fetch(url).then(function(x){
    return x.json().data.records;
  });
}

function find_citations(package){
  return find_package(package).then(function(pkg){
    return find_mentions(pkg['_id']).then(function(mentions){
      pkg.mentions = mentions;
      return pkg;
    }).catch(function(err){
      return pkg; //ignore error for now
    });
  });
}

router.get('/shared/scienceminer/:package', function(req, res, next) {
  find_package(req.params.package).then(function(info){
    res.set('Cache-Control', 'max-age=3600, public').send(info);
  }).catch(error_cb(400, next));
});

router.get('/:user/scienceminer', function(req, res, next) {
  find_package(req.query.package).then(function(info){
    res.send(info);
  }).catch(error_cb(400, next));
});

module.exports = router;
