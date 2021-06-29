
# cranlike(7) &mdash; dynamic R package server

## SYNOPSIS

`GET`  
&nbsp; `/man`  
&nbsp; `/src/contrib`  
&nbsp; `/bin/windows/contrib`  
&nbsp; `/bin/macosx/contrib`  

`GET`  
&nbsp; `/stats/checks`  
&nbsp; `/stats/descriptions`  
&nbsp; `/stats/maintainers`  
&nbsp; `/stats/sysdeps`  
&nbsp; `/badges`  

`GET, PUT*, DELETE*`  
&nbsp; `/packages/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>  

`*` may require authentication

## DESCRIPTION

**cranlike** is a package server providing a simple API for storing
R packages and hosting cran-like repositories. 

Packages are published in the repository of a particular user or 
organization, and the server automatically generates the required 
repository index files from the database. 
This allows R users to install packages from a particular author or 
organization using only the repo parameter in `install.packages()`.

The implementation is designed to be fast and extensible, with the
potential expose additional filters or services, and scale up to
large repositories. The cranlike server itself does not handle auth,
you have to configure this in your web server.

## API

* `GET /man`  
  This manual page.

* `GET /{src,bin}/`  
  CRAN-like repository structure for packages in this universe.

* `GET /packages/`  
  JSON array of available packages in this universe.

* `GET /packages/`&lt;*package*>`/`  
  JSON array of available versions for <*package*> in this universe.

* `GET /packages/`&lt;*package*>`/`&lt;*version*>`/`  
  JSON array of builds for <*package*> <*version*> in this universe.

* `GET /stats/checks`  
  NDJSON stream with recent builds and checks.

* `GET /stats/descriptions`  
  NDJSON stream with data from package DESCRIPTION files.

* `GET /stats/maintainers`  
  NDJSON stream with unique maintainers, identified by email address.

* `GET /stats/sysdeps`  
  NDJSON stream with external libraries used in this universe.

* `GET /badges/`&lt;*package*>  
  SVG badge with current version of given package.

* `PUT /packages/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>`/`&lt;*md5*>` `   
  Publish a package via raw file upload. The <*type*> must be one of `{src,mac,win}`,
  and <*md5*> must be a string with the md5 hash of the file. 
  Additionional request headers starting with `Builder-` are stored as builder properties.

* `POST /packages/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>` `  
  Publish a package via multipart form-data in the `file` field. 
  The <*type*> must be one of `{src,mac,win}`. Additionional form-fields
  starting with `Builder-` are stored as builder properties.

* `DELETE /packages/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>` `  
  Delete one or more package files. Both <*version*> and <*type*> are optional,
  if unspecified all matches are deleted.

## EXAMPLES
*# install a package from 'ropensci' universe*  
install.packages("gert", repos = "[https://ropensci.r-universe.dev](https://ropensci.r-universe.dev)")  
