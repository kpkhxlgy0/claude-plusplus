let settingsHandle = null;

module.exports = {
  start(api) {
    settingsHandle = api.settings?.registerPage({
      id: "probe",
      title: "Claude++ Probe",
      render(root) {
        root.textContent = "Claude++ settings page is active.";
      },
    }) ?? null;
  },
  stop() {
    settingsHandle?.unregister();
    settingsHandle = null;
  },
};
