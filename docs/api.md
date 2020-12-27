
# cranlike(7) &mdash; dynamic R package server

## SYNOPSIS

`GET`  
&nbsp; `/src/contrib`  
&nbsp; `/bin/windows/contrib`  
&nbsp; `/bin/macosx/contrib`  

`GET`  
&nbsp; `/stats/stats/checks`  
&nbsp; `/stats/stats/descriptions`  
&nbsp; `/stats/stats/maintainers`  
&nbsp; `/stats/stats/sysdeps`  

`GET,PUT,DELETE`  
&nbsp; `/packages/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>  

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

* `GET /{src,bin}/`  
  CRAN-like repository for packages published current user

* `GET /packages/`  
  JSON array of available packages from <*user*>.

* `GET /packages/`&lt;*package*>`/`  
  JSON array of available versions for <*package*> from <*user*>.

* `GET /packages/`&lt;*package*>`/`&lt;*version*>`/`  
  JSON array of builds for <*package*> <*version*> from <*user*>.

* `GET /stats/checks`  
  JSONLD stream with recent builds and checks.

* `GET /stats/descriptions`  
  JSONLD stream with data from package DESCRIPTION files.

* `GET /stats/maintainers`  
  JSONLD stream with unique maintainers, identified by email address.

* `GET /stats/sysdeps`  
  JSONLD stream with external libraries used in this universe.

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

install.packages("curl", repos = "[https://jeroen.r-universe.dev](https://jeroen.r-universe.dev)")  
