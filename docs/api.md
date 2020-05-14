
# cranlike(7) &mdash; dynamic R package server

## SYNOPSIS

`GET`  
&nbsp; `/`&lt;*user*>`/src/contrib`  
&nbsp; `/`&lt;*user*>`/bin/windows/contrib`  
&nbsp; `/`&lt;*user*>`/bin/macosx/contrib/`  

`GET,POST,DELETE`  
&nbsp; `/`&lt;*user*>`/packages/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>  

`GET`
&nbsp; `/`&lt;*user*>`/stats/stats/checks`

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
large repositories. Currently cranlike does not handle auth, so
you have to configure this in your web server.

## API

* `GET /`  
  List available users / organizations.

* `GET /`&lt;*user*>` `  
  Some info / package stats for given author or organization.

* `GET /`&lt;*user*>`/{src,bin}/`  
  CRAN-like repository for packages published by  <*user*>.

* `GET /`&lt;*user*>`/packages/`  
  JSON array of available packages from <*user*>.

* `GET /`&lt;*user*>`/packages/`&lt;*package*>`/`  
  JSON array of available versions for <*package*> from <*user*>.

* `GET /`&lt;*user*>`/packages/`&lt;*package*>`/`&lt;*version*>`/`  
  JSON array of builds for <*package*> <*version*> from <*user*>.

* `PUT /`&lt;*user*>`/packages/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>`/`&lt;*md5*>` `   
  Publish a package via raw file upload. The <*type*> must be one of `{src,mac,win}`,
  and <*md5*> must be a string with the md5 hash of the file. 
  Additionional request headers starting with `Builder-` are stored as builder properties.

* `POST /`&lt;*user*>`/packages/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>` `  
  Publish a package via multipart form-data in the `file` field. 
  The <*type*> must be one of `{src,mac,win}`. Additionional form-fields
  starting with `Builder-` are stored as builder properties.

* `DELETE /`&lt;*user*>`/packages/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>` `  
  Delete one or more package files. Both <*version*> and <*type*> are optional,
  if unspecified all matches are deleted.

## EXAMPLES

install.packages('curl', repos = "https://repos.mycorp.org/jeroen")  
