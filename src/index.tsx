import React from 'react';
import { Icons } from '@ohif/ui-next';
import { id } from './id.js';
import Flame from './icons/Flame';
import commandsModule from './commandsModule';
import getCustomizationModule from './getCustomizationModule';
import getSopClassHandlerModule from './getSopClassHandlerModule';
import getDataSourcesModule from './getDataSourcesModule';
import getPanelModule from './getPanelModule';
import {
  startFhircastContextListener,
  suspendFhircastContextListener,
} from './Panels/fhircast/fhircastContextListener';
import getHangingProtocolModule from './getHangingProtocolModule';
import getLayoutTemplateModule from './getLayoutTemplateModule';
import initTools from './initTools';
import getToolbarButtons from './toolbarButtons';
import registerHangingProtocolAttributes from './registerHangingProtocolAttributes';
import { activatePanelFromUrl } from './panelFromUrl';

const Component = React.lazy(() => {
  return import(/* webpackPrefetch: true */ './viewports/EcgViewport');
});

const EcgViewport = props => {
  return (
    <React.Suspense fallback={<div>Loading...</div>}>
      <Component {...props} />
    </React.Suspense>
  );
};

export default {
  id,

  preRegistration({ servicesManager }) {
    Icons.addIcon('fhir-flame', Flame);
    initTools();
    registerHangingProtocolAttributes({ servicesManager });
  },

  onModeEnter({ servicesManager, commandsManager }) {
    const { toolbarService } = servicesManager.services;
    toolbarService.register(getToolbarButtons());
    activatePanelFromUrl(servicesManager);
    // Follow FHIRcast context for as long as the viewer is up, not just while
    // the FHIRcast tab is the one selected.
    startFhircastContextListener({ servicesManager, commandsManager });
  },

  onModeExit() {
    suspendFhircastContextListener();
  },

  getCommandsModule(params) {
    return commandsModule(params);
  },

  getCustomizationModule,

  getViewportModule({ servicesManager, extensionManager }) {
    const ExtendedEcgViewport = props => {
      return (
        <EcgViewport
          servicesManager={servicesManager}
          extensionManager={extensionManager}
          {...props}
        />
      );
    };

    return [{ name: 'ecg-dicom', component: ExtendedEcgViewport }];
  },

  getSopClassHandlerModule,
  getDataSourcesModule,
  getPanelModule,
  getHangingProtocolModule,
  getLayoutTemplateModule,
};
