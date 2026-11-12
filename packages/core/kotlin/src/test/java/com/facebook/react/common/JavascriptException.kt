package com.facebook.react.common

/**
 * Stands in for React Native's real JavascriptException, which is not on the
 * unit-test classpath (the RN artifact is an Android library, and these tests
 * run on a bare JVM).
 *
 * Detection is by fully-qualified class name, so what matters is that this lives
 * in the same package under the same name as the real one.
 */
class JavascriptException(message: String) : RuntimeException(message)
