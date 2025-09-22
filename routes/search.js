/* Packages */
import express from 'express';
import createError from 'http-errors';
import {packages} from '../src/db.js';

const router = express.Router();

/* NB: regex queries are slow because not indexable! */
function build_query(query, str){
  function substitute(name, field, insensitive, partial){
    var re = new RegExp(`${name}:(\\S*)`, "i"); //the name is insensitive e.g.: "Package:jsonlite"
    var found = str.match(re);
    if(found && !found[1]){
      throw createError(400, `Invalid search query: "${name}:" is followed by whitespace`);
    }
    if(found && found[1]){
      var search = found[1];
      if(insensitive || partial){
        search = search.replaceAll("+", "."); //search for: "author:van+buuren" or "topic:open+data"
        var regex = partial ? search : `^${search}$`;
        var opt = insensitive ? 'i' : '';
        query[field] = {$regex: regex, $options: opt}
      } else if (field == '_nocasepkg'){
        query[field] = search.toLowerCase();
      } else {
        query[field] = search;
      }
      str = str.replace(re, "");
    }
  }
  function match_exact(name, field){
    substitute(name, field)
  }
  function match_insensitive(name, field){
    substitute(name, field, true)
  }
  function match_partial(name, field){
    substitute(name, field, true, true)
  }
  function match_exists(name, field){
    var re = new RegExp(`${name}:(\\S+)`, "i");
    var found = str.match(re);
    if(found && found[1]){
      var findfield = found[1].toLowerCase(); //GH logins are normalized to lowercase
      query[`${field}.${findfield}`] = { $exists: true };
      str = str.replace(re, "");
    }
  }
  match_partial('author', 'Author');
  match_partial('maintainer', 'Maintainer');
  match_exact('needs', '_rundeps');
  match_exact('package', '_nocasepkg'); //always case insenstive
  match_exact('contributor', '_contributors.user');
  match_exact('topic', '_topics');
  match_exact('exports', '_exports');
  match_exact('owner', '_owner');
  match_exact('user', '_user');
  match_exact('fileid', '_fileid')
  match_exact('universe', '_universes');
  match_partial('data', '_datasets.title');
  str = str.trim();
  var unknown = str.match("(\\S+):(\\S+)");
  if(unknown && unknown[1]){
    throw createError(400, `Invalid search query: "${unknown[1]}:" is not a supported field.`);
  }
  if(str){
    query['$text'] = { $search: str, $caseSensitive: false};
  }
}

router.get("/:user/api/search", function(req, res, next) {
  return Promise.resolve().then(() => {
    var query = req.params.user == ":any" ?
      {_type: 'src', _indexed : true} :
      {_type: 'src', _registered : true, _universes: req.params.user};
    build_query(query, req.query.q || "");
    var project = {
      Package: 1,
      Title: 1,
      Description:1,
      _user:1,
      _score: 1,
      _usedby: 1,
      _searchresults: 1,
      _uuid: '$_userbio.uuid',
      maintainer: '$_maintainer',
      updated: '$_commit.time',
      stars: '$_stars',
      topics: '$_topics'
    };
    if(query['$text']){
      project.match = {$meta: "textScore"};
      project.rank = {$multiply:[{ $min: [{$meta: "textScore"}, 150]}, '$_score']};
    } else {
      project.rank = '$_score';
    }
    var limit =  parseInt(req.query.limit) || 100;
    var skip =  parseInt(req.query.skip) || 0;
    var cursor = packages.aggregate([
      { $match: query},
      { $project: project},
      { $sort: {rank: -1}},
      { $facet: {
          results: [{ $skip: skip }, { $limit: limit }],
          stat: [{$count: 'total'}]
        }
      }
    ]);
    return cursor.next().then(function(out){
      out.query = query;
      out.skip = skip;
      out.limit = limit;
      if(out.stat && out.stat.length){
        out.total = out.stat[0].total;
      }
      //remove fields unrelated to the search
      delete out.query._type;
      delete out.query._registered;
      delete out.query._indexed;
      delete out.stat;
      return res.send(out);
    })
  }).catch(function(err){
    // Send API response errors in text instead of html
    res.status(400).type('text/plain').send(err.message || err);
  });
});

router.get("/:user/stats/powersearch", function(req, res, next) {
  res.redirect(req.url.replace("stats/powersearch", "api/search"))
});

export default router;