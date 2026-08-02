/**
 * @format
 */

import 'react-native';
import React from 'react';
import App from '../App';

// Note: import explicitly to use the types shipped with jest.
import {it} from '@jest/globals';

// Note: test renderer must be required after react-native.
import renderer, {act} from 'react-test-renderer';

// App's mount effects (persisted identity/relay load + the dpay-core self-check) are async. Wrapping
// the render in an async act flushes those settled promises (and their console.log/state updates)
// inside the test boundary, then unmounting frees the renderer — so nothing schedules work after
// the test ends (which previously surfaced as jest's "Cannot log after tests are done" + a CLI
// exit code of 1 even though every suite/test passed).
it('renders correctly', async () => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<App />);
  });
  act(() => {
    tree.unmount();
  });
});
