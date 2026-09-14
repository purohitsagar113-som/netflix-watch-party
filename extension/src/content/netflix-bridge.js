// CineSync Netflix MAIN World Bridge Script
// Injected into the page execution context to access window.netflix Cadmium video player API

(function() {
  console.log("[CineSync Bridge] Injected into Netflix DOM context.");

  function getNetflixPlayer() {
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.();
      if (!api || !api.videoPlayer) return null;
      
      const sessionIds = api.videoPlayer.getAllPlayerSessionIds();
      if (!sessionIds || sessionIds.length === 0) return null;

      return api.videoPlayer.getVideoPlayerBySessionId(sessionIds[0]);
    } catch (err) {
      console.warn("[CineSync Bridge] Unable to retrieve Netflix player instance:", err);
      return null;
    }
  }

  // Listen for sync execution commands from content.js
  window.addEventListener("cinesync_command", (event) => {
    const { action, time } = event.detail || {};
    const player = getNetflixPlayer();

    if (player) {
      try {
        if (action === "SEEK" && typeof time === "number") {
          player.seek(Math.round(time * 1000)); // Netflix Cadmium API accepts milliseconds
        } else if (action === "PLAY") {
          player.play();
        } else if (action === "PAUSE") {
          player.pause();
        }
      } catch (err) {
        console.error("[CineSync Bridge] Error invoking Netflix Cadmium API:", err);
      }
    } else {
      // Fallback directly to native video element if Cadmium API isn't present
      const video = document.querySelector("video");
      if (video) {
        if (action === "SEEK" && typeof time === "number") video.currentTime = time;
        else if (action === "PLAY") video.play().catch(() => {});
        else if (action === "PAUSE") video.pause();
      }
    }
  });

  // Query current precise state on demand
  window.addEventListener("cinesync_query_state", () => {
    const player = getNetflixPlayer();
    let state = null;

    if (player) {
      state = {
        currentTime: player.getCurrentTime() / 1000,
        paused: player.isPaused(),
        duration: player.getDuration() / 1000,
        busy: player.isBusy()
      };
    } else {
      const video = document.querySelector("video");
      if (video) {
        state = {
          currentTime: video.currentTime,
          paused: video.paused,
          duration: video.duration,
          busy: false
        };
      }
    }

    window.dispatchEvent(new CustomEvent("cinesync_state_response", { detail: state }));
  });
})();
