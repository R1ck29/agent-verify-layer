cachetools
========================================================================

This module provides various memoizing collections and decorators,
including variants of the Python Standard Library's `@lru_cache`_
function decorator.

.. code-block:: python

   from cachetools import cached, LRUCache, TTLCache

   # speed up calculating Fibonacci numbers with dynamic programming
   @cached(cache={})
   def fib(n):
       return n if n < 2 else fib(n - 1) + fib(n - 2)

   # cache least recently used Python Enhancement Proposals
   @cached(cache=LRUCache(maxsize=32))
   def get_pep(num):
       from urllib.request import urlopen
       url = 'https://peps.python.org/pep-%04d/' % num
       with urlopen(url) as s:
           return s.read()

   # cache PyOWM weather data for no longer than ten minutes
   from pyowm.owm import OWM
   owm = OWM('your-free-api-key')

   @cached(cache=TTLCache(maxsize=1024, ttl=600))
   def get_weather(place):
       return owm.weather_manager().weather_at_place(place).weather

For the purpose of this module, a *cache* is a mutable_ mapping_ of a
fixed maximum size.  When the cache is full, i.e. by adding another
item the cache would exceed its maximum size, the cache must choose
which item(s) to discard based on a suitable `cache algorithm`_.

This module provides multiple cache classes based on different cache
algorithms, as well as decorators for easily memoizing function and
method calls.


Installation
------------------------------------------------------------------------

cachetools is available from PyPI_ and can be installed by running::

  pip install cachetools


Project Resources
------------------------------------------------------------------------

- `Documentation`_
- `Issue tracker`_
- `Source code`_
- `Change log`_


Related Projects
------------------------------------------------------------------------

- asyncache_: Helpers to use cachetools_ with asyncio.
- cachetools-async_: Helpers to use cachetools_ with asyncio.
- cacheing_: Pure Python Cacheing Library.
- CacheToolsUtils_: Stackable cache classes for sharing, encryption,
  statistics *and more* on top of cachetools_, redis_ and memcached_.
- shelved-cache_: Persistent cache implementation for Python
  cachetools_.


License
------------------------------------------------------------------------

Copyright (c) 2014-2026 Thomas Kemmer.

Licensed under the `MIT License`_.


.. _@lru_cache: https://docs.python.org/3/library/functools.html#functools.lru_cache
.. _mutable: https://docs.python.org/3/glossary.html#term-mutable
.. _mapping: https://docs.python.org/3/glossary.html#term-mapping
.. _cache algorithm: https://en.wikipedia.org/wiki/Cache_algorithms

.. _PyPI: https://example.invalid/
.. _Documentation: https://example.invalid/
.. _Issue tracker: https://example.invalid/
.. _Source code: https://example.invalid/
.. _Change log: https://example.invalid/
.. _MIT License: https://example.invalid/

.. _asyncache: https://pypi.org/project/asyncache/
.. _cachetools-async: https://example.invalid/
.. _cacheing: https://pypi.org/project/cacheing/
.. _CacheToolsUtils: https://example.invalid/
.. _shelved-cache: https://pypi.org/project/shelved-cache/
.. _cachetools: https://example.invalid/
.. _redis: https://redis.io/
.. _memcached: https://memcached.org/
