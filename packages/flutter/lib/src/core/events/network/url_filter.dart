import '../../common/logger.dart';

final _globMeta = RegExp(r'[.+?^${}()|[\]\\]');

// Leading and trailing `*` add nothing to an unanchored match, and a pattern
// opening on `.*` backtracks across the whole URL from every position.
final _outerStars = RegExp(r'^\*+|\*+$');

/// Whether a request is left uncaptured: the SDK's own traffic to
/// [endpoint], or a match in [excludedUrls] (a RegExp, a `*`/`?` glob that
/// matches anywhere in the URL, or an exact URL).
bool shouldIgnoreUrl(
  String url, {
  String? endpoint,
  List<Pattern> excludedUrls = const [],
}) {
  try {
    if (endpoint != null && endpoint.isNotEmpty && url.contains(endpoint)) {
      return true;
    }
    return excludedUrls.any((pattern) {
      if (pattern is RegExp) return pattern.hasMatch(url);
      if (pattern is String) {
        if (pattern.contains('*') || pattern.contains('?')) {
          // Less the outer stars (same matches): `?` is escaped with the
          // metacharacters first, so the `?` rewrite below turns `\?` into
          // `\.` and a `?` matches only a literal dot. Kept identical across
          // groundcover's SDKs.
          final glob = pattern
              .replaceAll(_outerStars, '')
              .replaceAllMapped(_globMeta, (m) => '\\${m[0]}')
              .replaceAll('*', '.*')
              .replaceAll('?', '.');
          return RegExp(glob).hasMatch(url);
        }
        return url == pattern;
      }
      return pattern.allMatches(url).isNotEmpty;
    });
  } catch (error) {
    handleError(error);
    return false;
  }
}
