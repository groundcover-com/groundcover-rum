// Metro cannot resolve the symlinked @groundcover/react-native from a pnpm workspace without
// this: watch the whole workspace, check the app's node_modules then the root, and disable
// hierarchical lookup so Metro cannot walk parent dirs into phantom deps. The app consumes the
// SDK's BUILT dist, so core TS never runs through Babel here.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
