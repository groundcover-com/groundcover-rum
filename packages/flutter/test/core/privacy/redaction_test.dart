// Port of packages/core/ts/src/privacy/redaction.test.ts. The JS-only cases
// (hostile getters, opaque host nodes, a hook returning `null` as a value) have
// no Dart counterpart and are left out.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:groundcover_rum/src/core/config/types.dart';
import 'package:groundcover_rum/src/core/privacy/privacy_config.dart';
import 'package:groundcover_rum/src/core/privacy/redaction.dart';

Map<String, String> parseQuery(String query) {
  final values = <String, String>{};
  for (final pair in query.replaceFirst(RegExp(r'^\?'), '').split('&')) {
    if (pair.isEmpty) continue;
    final eq = pair.indexOf('=');
    String decode(String v) => Uri.decodeComponent(v.replaceAll('+', ' '));
    final key = decode(eq == -1 ? pair : pair.substring(0, eq));
    values.putIfAbsent(
      key,
      () => eq == -1 ? '' : decode(pair.substring(eq + 1)),
    );
  }
  return values;
}

final encodedRedacted = Uri.encodeComponent(redacted);

void main() {
  group('isSensitiveKey', () {
    test('matches built-in sensitive patterns', () {
      for (final key in [
        'password',
        'user_token',
        'apiKey',
        'api-key',
        'Authorization',
        'creditCard',
        'cardNumber',
      ]) {
        expect(isSensitiveKey(key), isTrue, reason: key);
      }
    });

    test('does not over-match innocuous keys', () {
      for (final key in ['cardinality', 'session_id', 'username', 'email']) {
        expect(isSensitiveKey(key), isFalse, reason: key);
      }
    });

    test('honors extra keys', () {
      expect(isSensitiveKey('ssn'), isTrue);
      expect(isSensitiveKey('internal_ref', ['internal_ref']), isTrue);
      expect(isSensitiveKey('internal_ref'), isFalse);
    });
  });

  group('redactHeaders', () {
    test('redacts sensitive header names and patterns, keeps others', () {
      final result = redactHeaders({
        'Authorization': 'Bearer abc',
        'Cookie': 'sid=1',
        'x-api-token': 'secret',
        'Content-Type': 'application/json',
        'Accept': '*/*',
      });
      expect(result['Authorization'], redacted);
      expect(result['Cookie'], redacted);
      expect(result['x-api-token'], redacted);
      expect(result['Content-Type'], 'application/json');
      expect(result['Accept'], '*/*');
    });

    test('redacts header names containing a bare `key` substring', () {
      final result = redactHeaders({
        'x-functions-key': 'abc',
        'x-encryption-key': 'def',
        'x-key': 'ghi',
      });
      expect(result.values, everyElement(redacted));
    });
  });

  group('redactQueryString', () {
    test('redacts sensitive params and preserves the rest', () {
      final params = parseQuery(
        redactQueryString('user=bob&token=abc123&page=2'),
      );
      expect(params['user'], 'bob');
      expect(params['token'], redacted);
      expect(params['page'], '2');
    });

    test('returns input unchanged when nothing is sensitive', () {
      expect(redactQueryString('a=1&b=2'), 'a=1&b=2');
    });

    test('preserves repeated keys', () {
      expect(
        redactQueryString('token=a&token=b&user=x'),
        'token=$encodedRedacted&token=$encodedRedacted&user=x',
      );
    });

    test('redacts OAuth params (code/state/session_state) by exact key', () {
      final params = parseQuery(
        redactQueryString(
          'code=authcode123&state=csrf456&session_state=s789&page=2',
        ),
      );
      expect(params['code'], redacted);
      expect(params['state'], redacted);
      expect(params['session_state'], redacted);
      expect(params['page'], '2');
    });

    test('does not redact params that merely contain code/state', () {
      final params = parseQuery(
        redactQueryString('zipcode=90210&statename=CA&mode=dark'),
      );
      expect(params['zipcode'], '90210');
      expect(params['statename'], 'CA');
      expect(params['mode'], 'dark');
    });
  });

  group('redactUrl', () {
    test('redacts query params and keeps path and fragment', () {
      final out = redactUrl('https://x.com/p?token=abc&q=1#frag');
      expect(out, contains('https://x.com/p?'));
      expect(out, contains('token=$encodedRedacted'));
      expect(out, contains('q=1'));
      expect(out, contains('#frag'));
    });

    test('leaves URLs without a query untouched', () {
      expect(redactUrl('https://x.com/path'), 'https://x.com/path');
    });

    test('redacts an OAuth authorization-code callback URL', () {
      final out = redactUrl(
        'https://app.com/?code=authcode123&state=csrf456&page=2',
      );
      expect(out, isNot(contains('authcode123')));
      expect(out, isNot(contains('csrf456')));
      expect(out, contains('page=2'));
    });

    test('redacts a query inside the fragment, after a real query', () {
      final out = redactUrl(
        'https://app.com/path?a=1#/reset?token=SUPERSECRET&section=2',
      );
      expect(out, isNot(contains('SUPERSECRET')));
      expect(out, contains('a=1'));
      expect(out, contains('section=2'));
      expect(out, contains('#/reset?'));
    });

    test('redacts a query inside the fragment, with no query before it', () {
      final out = redactUrl('https://app.com/#/auth?access_token=SUPERSECRET');
      expect(out, isNot(contains('SUPERSECRET')));
      expect(out, contains('#/auth?'));
    });

    test('strips embedded userinfo', () {
      final out = redactUrl('https://admin:s3cr3t@internal.api/data?x=1');
      expect(out, isNot(contains('s3cr3t')));
      expect(out, isNot(contains('admin:')));
      expect(out, contains('@internal.api/data'));
      expect(out, contains('x=1'));
    });

    test('does not treat an @ in the query as userinfo', () {
      expect(redactUrl('https://x.com/p?email=a@b.com'), contains('a@b.com'));
    });
  });

  group('redactBody', () {
    test('deep-redacts JSON object bodies', () {
      final parsed =
          jsonDecode(
                redactBody(
                  '{"user":"bob","password":"hunter2","nested":{"token":"t"}}',
                ),
              )
              as Map;
      expect(parsed['user'], 'bob');
      expect(parsed['password'], redacted);
      expect((parsed['nested'] as Map)['token'], redacted);
    });

    test('a hook value JSON has no form for never reopens the body', () {
      final calls = <String>[];
      final out = redactBody(
        '{"amount":5,"tokens":["tok_A","tok_B"],"password":{"x":"p1"}}',
        RedactOptions(
          redact: (field) {
            calls.add(field.key);
            return field.key == 'amount' ? double.nan : null;
          },
        ),
      );
      // As JSON.stringify writes NaN; the sensitive keys stay redacted whole.
      expect(jsonDecode(out), {
        'amount': null,
        'tokens': redacted,
        'password': redacted,
      });
      expect(calls, isNot(contains('')), reason: 'no whole-body second pass');
    });

    test('writes JSON numbers back as JSON.stringify does', () {
      expect(
        redactBody('{"amount": 1.0, "e": 1e3, "x": 1.5, "n": [2.0]}'),
        '{"amount":1,"e":1000,"x":1.5,"n":[2]}',
      );
    });

    test('redacts JSON inside arrays', () {
      final parsed =
          jsonDecode(redactBody('[{"secret":"x"},{"ok":"y"}]')) as List;
      expect((parsed[0] as Map)['secret'], redacted);
      expect((parsed[1] as Map)['ok'], 'y');
    });

    test('redacts form-encoded bodies', () {
      final params = parseQuery(
        redactBody('grant_type=password&password=secret&user=bob'),
      );
      expect(params['password'], redacted);
      expect(params['user'], 'bob');
    });

    test('redacts an analytics writeKey in a JSON body', () {
      final parsed =
          jsonDecode(
                redactBody(
                  '{"writeKey":"test-write-key-0000000000","event":"track"}',
                ),
              )
              as Map;
      expect(parsed['writeKey'], redacted);
      expect(parsed['event'], 'track');
    });

    test('does NOT redact generic code/state keys inside JSON bodies', () {
      final parsed =
          jsonDecode(redactBody('{"code":200,"state":"open","user":"bob"}'))
              as Map;
      expect(parsed['code'], 200);
      expect(parsed['state'], 'open');
    });

    test('falls back to the free-text scrub for non-JSON', () {
      expect(redactBody('login failed for token: abc123'), contains(redacted));
    });

    test('bounds deep nesting and never leaks below the depth cap', () {
      Object deep = {'password': 'x'};
      for (var i = 0; i < 50; i++) {
        deep = {'nested': deep};
      }
      final out = redactBody(jsonEncode(deep));
      expect(out, isNot(contains('"password":"x"')));
    });

    test('preserves array length', () {
      final arr = [
        for (var i = 0; i < 5000; i++) {'i': i},
      ];
      expect(jsonDecode(redactBody(jsonEncode(arr))), hasLength(5000));
    });

    test('falls back to a text scrub for oversized JSON bodies', () {
      final filler = 'x' * 200000;
      final out = redactBody('{"password":"secret","note":"$filler"}');
      expect(out, contains(redacted));
      expect(out, isNot(contains('secret')));
    });

    test('returns empty input unchanged', () {
      expect(redactBody(''), '');
    });
  });

  group('redactText', () {
    test('scrubs a key only the app calls sensitive, and leaves the rest', () {
      const opts = RedactOptions(sensitiveKeys: ['order_id']);
      expect(
        redactText('order_id=42 for bob', opts),
        'order_id=[REDACTED] for bob',
      );
      expect(
        redactText('cart has 3 items, total 42', opts),
        'cart has 3 items, total 42',
      );
    });

    test('scrubs key=value and key: value pairs', () {
      expect(redactText('password=secret'), contains(redacted));
      expect(redactText('token: abc123'), contains(redacted));
    });

    test('leaves non-sensitive text untouched', () {
      expect(
        redactText('user logged in successfully'),
        'user logged in successfully',
      );
    });

    test('redacts the whole value after a space', () {
      final out = redactText('Authorization: Bearer eyJtoken123');
      expect(out, isNot(contains('eyJtoken123')));
      expect(out, isNot(contains('Bearer')));
      expect(out, contains(redacted));
    });

    test('redacts a sensitive pair inside a printed Dart Map', () {
      // Map.toString() is `{key: value, …}`: a harmless label before the
      // map must not swallow the pairs inside it.
      final headers = redactText(
        'Request headers: {Authorization: Bearer eyJ.abc.def, '
        'Accept: application/json}',
      );
      expect(headers, isNot(contains('eyJ.abc.def')));
      expect(headers, contains('Accept: application/json'));
      final user = redactText('User: {token: abc123, name: bob}');
      expect(user, isNot(contains('abc123')));
      expect(user, contains('name: bob'));
      final nested = redactText('ctx: {req: {headers: {x_auth: s3cr3t}}}');
      expect(nested, isNot(contains('s3cr3t')));
    });

    test('does not bleed past a line boundary', () {
      final out = redactText('token: abc123\nstatus: ok');
      expect(out, isNot(contains('abc123')));
      expect(out, contains('status: ok'));
    });

    test('redacts OAuth code/state in query-shaped free text', () {
      final out = redactText('callback code=oauthcode123&state=csrf456&page=2');
      expect(out, isNot(contains('oauthcode123')));
      expect(out, isNot(contains('csrf456')));
      expect(out, contains('page=2'));
    });

    test('does not redact `code:`/`state:` in plain log lines', () {
      final out = redactText('request finished code: 200 state: idle');
      expect(out, contains('200'));
      expect(out, contains('idle'));
    });

    test('redacts header-style bare-`key` names', () {
      final out = redactText('x-functions-key: supersecret');
      expect(out, isNot(contains('supersecret')));
      expect(out, contains(redacted));
    });

    test('redacts a sensitive pair embedded after a harmless key=', () {
      final out = redactText(
        'navigated to /login?next=/home?token=SUPERSECRET',
      );
      expect(out, isNot(contains('SUPERSECRET')));
      expect(out, contains(redacted));
    });

    test('bounds work on oversized input', () {
      final out = redactText('${'a' * 200000} token=SUPERSECRET');
      expect(out, isNot(contains('SUPERSECRET')));
      expect(out.endsWith('…'), isTrue);
    });
  });

  group('redactObject', () {
    test('deep-redacts without mutating the input', () {
      final input = <String, Object?>{
        'a': '1',
        'secret': 'x',
        'nested': {'token': 't'},
      };
      final out = redactObject(input);
      expect(out['secret'], redacted);
      expect((out['nested'] as Map)['token'], redacted);
      expect(input['secret'], 'x');
    });

    test('terminates on a cycle', () {
      final a = <String, Object?>{'name': 'a'};
      final b = <String, Object?>{'name': 'b', 'a': a};
      a['b'] = b;
      final out = redactObject(a);
      expect(out['name'], 'a');
      expect((out['b'] as Map)['a'], redacted);
    });

    test('walks a map shared between siblings', () {
      final shared = {'city': 'NYC'};
      final out = redactObject({'home': shared, 'work': shared});
      expect((out['home'] as Map)['city'], 'NYC');
      expect((out['work'] as Map)['city'], 'NYC');
    });

    test('stringifies a value that is neither a container nor a primitive', () {
      final out = redactObject({'when': DateTime.utc(2027, 1, 15)});
      expect(out['when'], '2027-01-15 00:00:00.000Z');
    });
  });

  group('redactLogFields', () {
    const privacy = EffectivePrivacy(
      level: PrivacyLevel.maskSensitive,
      maskNetworkBodies: true,
      maskNetworkQueryParams: true,
      maskLogs: true,
      maskErrors: true,
      sensitiveKeys: [],
    );

    test('masks message text and attribute values', () {
      final out = redactLogFields(privacy, 'login password=secret', {
        'password': 'secret',
        'user': 'bob',
      });
      expect(out.message, 'login password=[REDACTED]');
      expect(out.attributes?['password'], redacted);
      expect(out.attributes?['user'], 'bob');
    });

    test('is a no-op when log masking is off', () {
      final off = resolvePrivacy(const PrivacyOptions(maskLogs: false));
      final out = redactLogFields(off, 'password=secret', {
        'password': 'secret',
      });
      expect(out.message, 'password=secret');
      expect(out.attributes?['password'], 'secret');
    });
  });

  group('the redact hook', () {
    test(
      'is called per leaf with typed value, path, kind and sensitive flag',
      () {
        final seen = <Map<String, Object?>>[];
        redactObject(
          {
            'user': 'bob',
            'nested': {'count': 3},
          },
          RedactOptions(
            kind: RedactKind.log,
            redact: (f) {
              seen.add({
                'key': f.key,
                'value': f.value,
                'path': f.path,
                'kind': f.kind,
                'sensitive': f.sensitive,
              });
              return null;
            },
          ),
        );
        expect(
          seen,
          anyElement(
            equals({
              'key': 'user',
              'value': 'bob',
              'path': ['user'],
              'kind': RedactKind.log,
              'sensitive': false,
            }),
          ),
        );
        expect(
          seen,
          anyElement(
            equals({
              'key': 'count',
              'value': 3,
              'path': ['nested', 'count'],
              'kind': RedactKind.log,
              'sensitive': false,
            }),
          ),
        );
      },
    );

    test('is never called on containers, only leaves', () {
      final values = <Object?>[];
      redactObject(
        {
          'a': {
            'b': {'c': 'x'},
          },
        },
        RedactOptions(
          redact: (f) {
            values.add(f.value);
            return null;
          },
        ),
      );
      expect(values, ['x']);
    });

    test('can transform the original value', () {
      final out =
          jsonDecode(
                redactBody(
                  '{"card":"4111111111111111"}',
                  RedactOptions(
                    kind: RedactKind.requestBody,
                    redact: (f) => f.key == 'card'
                        ? '****${'${f.value}'.substring('${f.value}'.length - 4)}'
                        : null,
                  ),
                ),
              )
              as Map;
      expect(out['card'], '****1111');
    });

    test('redacts a field the built-ins miss', () {
      final out =
          jsonDecode(
                redactBody(
                  '{"nickname":"bob"}',
                  RedactOptions(
                    redact: (f) => f.key == 'nickname' ? redacted : null,
                  ),
                ),
              )
              as Map;
      expect(out['nickname'], redacted);
    });

    test('defers to the default when it returns null', () {
      final out =
          jsonDecode(
                redactBody(
                  '{"password":"hunter2","user":"bob"}',
                  RedactOptions(redact: (_) => null),
                ),
              )
              as Map;
      expect(out['password'], redacted);
      expect(out['user'], 'bob');
    });

    test("never sees the leaves of a sensitive key's subtree", () {
      final seen = <String>[];
      final out =
          jsonDecode(
                redactBody(
                  '{"credential":{"token":"x"}}',
                  RedactOptions(
                    redact: (f) {
                      seen.add(f.key);
                      return null;
                    },
                  ),
                ),
              )
              as Map;
      expect(out['credential'], redacted);
      expect(seen, isNot(contains('token')));
    });

    test('falls back to the built-in result when it throws', () {
      final out =
          jsonDecode(
                redactBody(
                  '{"password":"hunter2"}',
                  RedactOptions(redact: (_) => throw StateError('boom')),
                ),
              )
              as Map;
      expect(out['password'], redacted);
    });

    test('receives request-body vs response-body kinds', () {
      final kinds = <RedactKind?>[];
      Object? collect(RedactField f) {
        kinds.add(f.kind);
        return null;
      }

      redactBody(
        '{"a":"1"}',
        RedactOptions(kind: RedactKind.requestBody, redact: collect),
      );
      redactBody(
        '{"a":"1"}',
        RedactOptions(kind: RedactKind.responseBody, redact: collect),
      );
      expect(kinds, [RedactKind.requestBody, RedactKind.responseBody]);
    });

    test('is called once with the whole string for unstructured text', () {
      final seen = <(String, Object?)>[];
      redactText(
        'plain log line',
        RedactOptions(
          kind: RedactKind.log,
          redact: (f) {
            seen.add((f.key, f.value));
            return null;
          },
        ),
      );
      expect(seen, [('', 'plain log line')]);
    });

    test('a non-null result replaces a whole string, whatever its type', () {
      expect(redactText('token: abc', RedactOptions(redact: (_) => 0)), '0');
      expect(
        redactText('token: abc', RedactOptions(redact: (_) => false)),
        'false',
      );
      expect(
        redactText('token: abc', RedactOptions(redact: (_) => null)),
        contains(redacted),
      );
    });
  });
}
