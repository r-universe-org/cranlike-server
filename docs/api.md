
# cranlike(7) &mdash; dynamic R package server

## SYNOPSIS

`GET,POST,DELETE`  
&nbsp; `/api/`&lt;*user*>`/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>  

`GET`  
&nbsp; `/repos/`&lt;*user*>`/src/contrib`  
&nbsp; `/repos/`&lt;*user*>`/bin/windows/contrib`  
&nbsp; `/repos/`&lt;*user*>`/bin/macosx/el-capitan/contrib/`  


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
large repositories.

## API

* `GET /man`  
  List available users / organizations.

* `GET /repos/`&lt;*user*>`/`  
  CRAN-like repository for packages published by a given author
  or organization. Use `any` for packages from all users.

* `GET /api/`  
  List available users / organizations.

* `GET /api/`&lt;*user*>`/`  
  List available packages from <*user*>.

* `GET /api/`&lt;*user*>`/`&lt;*package*>`/`  
  List available versions for <*package*> from <*user*>.

* `GET /api/`&lt;*user*>`/`&lt;*package*>`/`&lt;*version*>`/`  
  List available files for <*package*> <*version*> from <*user*>.

* `POST /api/`&lt;*user*>`/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>`/`  
  Upload a package file via multipart form-data in the `file` field. 
  The <*type*> must be one of `{src,mac,win}`. Additionional form-fields
  starting with `Builder-` are stored as builder properties.


* `PUT /api/`&lt;*user*>`/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>`/`&lt;*md5*>` `   
  Upload a package as raw file post. The <*type*> must be one of `{src,mac,win}`,
  and <*md5*> must be a string with the md5 hash of the file. 
  Additionional request headers starting with `Builder-` are stored as builder properties.

* `DELETE /api/`&lt;*user*>`/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>`/`    
  Delete one or more package files. Both <*version*> and <*type*> are optional,
  if unspecified all matches are deleted.

## EXAMPLES

install.packages('curl', repos = "https://mycorp.org/repos/jeroen")  
