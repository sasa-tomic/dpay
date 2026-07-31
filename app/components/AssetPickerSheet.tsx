import {View, Text, Pressable, ScrollView, SafeAreaView, StatusBar, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {type CurrencyDescriptor, familyDisplay, assetTestKey} from '../config/catalog';
import {useEscapeToClose} from '../hooks/useHotkeys';

// Asset picker — shown from the header "Add money" button when more than one onrampable asset exists.
// A vertical list of the catalog's ramp assets (those carrying a minter_family); tapping a row opens
// that asset's family-specific deposit sheet. The picker is the cohesive entry for MANY currencies:
// every onrampable asset appears uniformly — there is no "supported"/"unsupported" split.
export function AssetPickerSheet({rampAssets, catalog, onPick, onClose}: {
  rampAssets: CurrencyDescriptor[];
  catalog: CurrencyDescriptor[];
  onPick: (currency: number) => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Add money</Text>
          <Pressable testID="btn-picker-close" style={S.sheetClose} onPress={onClose}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          <Text style={S.dim2}>Choose an asset to add to your wallet.</Text>
          {rampAssets.map(a => {
            const disp = familyDisplay(catalog, a.currency);
            const key = assetTestKey(a);
            return (
              <Pressable key={a.currency} testID={`asset-picker-row-${key}`} style={S.pickerRow} onPress={() => onPick(a.currency)}>
                <Text style={S.pickerLabel}>{disp.networkLabel}</Text>
                <Text style={S.pickerSub}>{`Send ${disp.nativeAsset} on ${disp.networkLabel}`}</Text>
              </Pressable>
            );
          })}
          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
