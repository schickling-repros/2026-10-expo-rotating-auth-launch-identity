import React from 'react';
import { Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import * as Updates from 'expo-updates';

const origin = 'http://127.0.0.1:18765';
const bundleKind = process.env.EXPO_PUBLIC_BUNDLE_KIND ?? 'embedded';
const report = async (event, data = {}) => {
  console.log('AUTH_REPRO', event, JSON.stringify(data));
  await fetch(`${origin}/evidence`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, bundleKind, updateId: Updates.updateId,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      isEmergencyLaunch: Updates.isEmergencyLaunch,
      emergencyLaunchReason: Updates.emergencyLaunchReason, ...data }),
  });
};
const run = async () => {
  await report('launch');
  const { scenario } = await (await fetch(`${origin}/scenario`)).json();
  if (scenario === 'rotate') {
    Updates.setUpdateRequestHeadersOverride({ Authorization: 'Bearer synthetic-token-A' });
    const result = await Updates.fetchUpdateAsync();
    await report('download', { result });
    Updates.setUpdateRequestHeadersOverride({ Authorization: 'Bearer synthetic-token-B' });
    await report('rotated-to-B');
    try {
      await Updates.reloadAsync();
    } catch (error) {
      await report('reload-rejected', { error: String(error), logs: await Updates.readLogEntriesAsync() });
    }
  } else if (scenario === 'restore-A') {
    Updates.setUpdateRequestHeadersOverride({ Authorization: 'Bearer synthetic-token-A' });
    await report('restored-A');
    await Updates.reloadAsync();
  } else if (scenario === 'persist-B') {
    Updates.setUpdateRequestHeadersOverride({ Authorization: 'Bearer synthetic-token-B' });
    await report('persisted-B');
  } else if (scenario === 'check-current') {
    const result = await Updates.checkForUpdateAsync();
    await report('check-current', { result });
  }
};
class App extends React.Component {
  componentDidMount() { run().catch(error => report('unexpected-error', { error: String(error) })); }
  render() {
    return React.createElement(View, { style: { flex: 1, padding: 48, justifyContent: 'center' } },
      React.createElement(Text, { style: { fontSize: 24 } }, `Bundle: ${bundleKind}\nEmbedded: ${Updates.isEmbeddedLaunch}\nEmergency: ${Updates.isEmergencyLaunch}\nID: ${Updates.updateId}\nSee local server evidence.`));
  }
}
registerRootComponent(App);
