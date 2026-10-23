/* Device permissions and preferences are intentionally separate from synced agenda settings. */
(function(){
'use strict';
window.SashidyNotifications = { init: function(app) {
  var bell=document.getElementById('bNotifications'), registration=null, currentSub=null, config=null, panel=null, busy=false;
  var prefs=defaults(), supported=!!(window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window);
  var errors={not_allowed:'Vincula este dispositivo con el código de tu agenda en Ajustes.',not_configured:'Falta completar la configuración de notificaciones en el servidor.',service_unavailable:'No se pudo conectar. Inténtalo de nuevo.',device_limit:'Se alcanzó el límite de 10 dispositivos.',try_later:'Espera un minuto antes de volver a probar.',expired_subscription:'El permiso caducó. Desactiva y vuelve a activar las notificaciones.',device_disabled:'Activa y guarda las notificaciones antes de probar.',invalid_subscription:'Este navegador no pudo registrar las notificaciones.',invalid_preferences:'Revisa la hora y la zona horaria.'};
  function defaults(){return {enabled:false,timed:true,daily:false,dailyTime:'08:00',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Guayaquil'};}
  function message(text){if(panel&&panel.isConnected){var el=panel.querySelector('#notifyMessage');el.textContent=text||'';el.hidden=!text;}}
  function indicator(){bell.dataset.active=String(prefs.enabled && supported && Notification.permission==='granted');}
  function request(action,data,code){
    code=code||app.getCode();
    if(!code)return Promise.reject(new Error(errors.not_allowed));
    return fetch('/api/notifications',{method:action?'POST':'GET',cache:'no-store',headers:{Authorization:'Bearer '+code,'Content-Type':'application/json'},
      body:action?JSON.stringify(Object.assign({action:action},data)):undefined}).then(function(r){return r.json().catch(function(){return {};}).then(function(d){if(!r.ok)throw new Error(errors[d.error]||'No se pudo guardar. Inténtalo de nuevo.');return d;});});
  }
  function reg(){
    if(registration)return Promise.resolve(registration);
    return navigator.serviceWorker.register('/sw.js').then(function(){return Promise.race([navigator.serviceWorker.ready,new Promise(function(_,reject){setTimeout(function(){reject(new Error('La agenda aún se está preparando. Vuelve a intentarlo.'));},12000);})]);}).then(function(r){registration=r;return r;});
  }
  function controls(){
    if(!panel||!panel.isConnected)return;
    if(!busy){
    panel.querySelector('#notifyEnabled').checked=prefs.enabled;
    panel.querySelector('#notifyTimed').checked=prefs.timed;
    panel.querySelector('#notifyDaily').checked=prefs.daily;
    panel.querySelector('#notifyTime').value=prefs.dailyTime;
    panel.querySelector('#notifyZone').textContent='Zona horaria: '+prefs.timeZone;
    }
    panel.querySelector('#notifyEnabled').disabled=busy||!supported||!app.getCode()||!config||(!config.ready&&!prefs.enabled);
    panel.querySelector('#notifyTimed').disabled=busy||!prefs.enabled;
    panel.querySelector('#notifyDaily').disabled=busy||!prefs.enabled;
    panel.querySelector('#notifyTime').disabled=busy||!prefs.enabled||!prefs.daily;
    panel.querySelector('#notifySave').disabled=busy||!supported||!app.getCode()||!config||(!config.ready&&!prefs.enabled);
    panel.querySelector('#notifyTest').disabled=busy||!prefs.enabled||!currentSub;
    var status=panel.querySelector('#notifyStatus');
    status.dataset.active=String(prefs.enabled&&config&&config.schedulerActive);
    status.textContent=prefs.enabled?(config&&config.schedulerActive?'Activadas en este dispositivo':'Activadas · envío automático pendiente'):'Desactivadas en este dispositivo';
  }
  async function loadPanel(){
    busy=true; controls();
    try {
      config=await request();
      if(supported){registration=await reg();currentSub=await registration.pushManager.getSubscription();}
      prefs=defaults();
      if(currentSub){var saved=await request('status',{subscription:currentSub.toJSON()});if(saved.preferences)prefs=saved.preferences;}
      if(supported&&Notification.permission!=='granted')prefs.enabled=false;
      if(!config.ready)message(errors.not_configured);
      else if(!config.schedulerActive)message('El envío automático aún no está confirmado. Falta activar o revisar el programador del servidor.');
      else message('');
    } catch(e){message(e.message);} finally{busy=false;controls();indicator();}
  }
  function readForm(){return {enabled:panel.querySelector('#notifyEnabled').checked,timed:panel.querySelector('#notifyTimed').checked,daily:panel.querySelector('#notifyDaily').checked,dailyTime:panel.querySelector('#notifyTime').value,timeZone:prefs.timeZone};}
  function bytes(value){var b=atob(value.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(b,function(c){return c.charCodeAt(0);});}
  async function save(permissionPromise){
    var next=readForm(), previous=prefs, newSub=false;
    busy=true;controls();message('Guardando…');
    try {
      if(next.enabled){
        var permission=await permissionPromise;
        if(permission!=='granted')throw new Error(permission==='denied'?'El navegador bloqueó las notificaciones. Permítelas en los ajustes del sitio.':'No se activaron las notificaciones. Puedes intentarlo cuando desees.');
        await app.sync();
        if(!app.synced())throw new Error('Primero necesitamos sincronizar tu agenda. Revisa la conexión y el código en Ajustes.');
        registration=await reg();currentSub=await registration.pushManager.getSubscription();
        if(currentSub && currentSub.options.applicationServerKey && !sameKey(currentSub.options.applicationServerKey,bytes(config.publicKey))){
          await request('disable',{subscription:currentSub.toJSON()});await currentSub.unsubscribe();currentSub=null;
        }
        if(!currentSub){currentSub=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(config.publicKey)});newSub=true;}
        await request('save',{subscription:currentSub.toJSON(),preferences:next});
      } else if(currentSub) {
        await request('disable',{subscription:currentSub.toJSON()});
        await currentSub.unsubscribe().catch(function(){});currentSub=null;
      }
      prefs=next;indicator();
      message(next.enabled?(config.schedulerActive?'Guardado. Las actividades con hora avisarán 10 minutos antes.':'Preferencias guardadas. Falta confirmar el envío automático del servidor.'):'Notificaciones desactivadas en este dispositivo.');
    } catch(e){if(newSub&&currentSub){await currentSub.unsubscribe().catch(function(){});currentSub=null;}prefs=previous;message(e.message);}
    finally{busy=false;controls();indicator();}
  }
  function sameKey(a,b){a=new Uint8Array(a);return a.length===b.length&&a.every(function(v,i){return v===b[i];});}
  function open(){
    panel=app.openSheet('<div class="notify-panel"><div class="notify-head"><h2 id="notifyTitle">Notificaciones</h2><button class="notify-close" id="notifyClose" aria-label="Cerrar">×</button></div><div class="notify-body">'+
      '<p class="notify-status" id="notifyStatus">Consultando este dispositivo…</p>'+
      '<label class="notify-row"><span><strong>En este dispositivo</strong><small>Recibir avisos en la pantalla</small></span><input class="notify-switch" id="notifyEnabled" type="checkbox" role="switch"></label>'+
      '<label class="notify-row"><span><strong>Actividades con hora</strong><small>Automáticamente, 10 minutos antes</small></span><input class="notify-switch" id="notifyTimed" type="checkbox" role="switch"></label>'+
      '<label class="notify-row"><span><strong>Actividades sin hora</strong><small>Recordarlas el día programado</small></span><input class="notify-switch" id="notifyDaily" type="checkbox" role="switch"></label>'+
      '<label class="notify-time-row" for="notifyTime">Hora del recordatorio<input id="notifyTime" type="time" value="08:00"></label><p class="notify-zone" id="notifyZone"></p>'+
      '<div class="notify-actions"><button id="notifyTest" type="button">Probar aviso</button><button class="notify-primary" id="notifySave" type="button">Guardar</button></div>'+
      '<p class="notify-message" id="notifyMessage" role="status" aria-live="polite" hidden></p><p class="notify-note">Activa la campanita en tu celular y en tu laptop usando la misma agenda.</p></div></div>');
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','notifyTitle');
    var close=function(){app.closeSheet();bell.focus();};
    panel.querySelector('#notifyClose').onclick=close;
    panel.addEventListener('keydown',function(e){
      if(e.key==='Escape'){e.preventDefault();close();}
      if(e.key==='Tab'){var f=Array.from(panel.querySelectorAll('button:not(:disabled),input:not(:disabled)')),first=f[0],last=f[f.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
    });
    panel.querySelector('#notifyClose').focus();
    panel.querySelector('#notifyEnabled').onchange=function(){
      // Ask in the click gesture, before any network request (required on iOS).
      var permission=panel.querySelector('#notifyEnabled').checked?Notification.requestPermission():Promise.resolve('granted');
      save(permission);
    };
    ['notifyTimed','notifyDaily'].forEach(function(id){panel.querySelector('#'+id).onchange=function(){var next=readForm();panel.querySelector('#notifyTime').disabled=!next.enabled||!next.daily;};});
    panel.querySelector('#notifySave').onclick=function(){save(Promise.resolve(supported?Notification.permission:'denied'));};
    panel.querySelector('#notifyTest').onclick=async function(){busy=true;controls();try{await request('test',{subscription:currentSub.toJSON()});message('Aviso enviado. Revisa las notificaciones del dispositivo.');}catch(e){message(e.message);}finally{busy=false;controls();}};
    controls();
    if(!supported){message('Para recibir avisos usa un navegador compatible. En iPhone o iPad, añade la agenda a la pantalla de inicio y ábrela desde su icono (iOS 16.4 o posterior).');return;}
    if(!app.getCode()){message(errors.not_allowed);return;}
    loadPanel();
  }
  document.addEventListener('keydown',function(e){if(panel&&panel.isConnected&&e.key==='Escape'){e.preventDefault();e.stopPropagation();app.closeSheet();bell.focus();}},true);
  bell.addEventListener('click',open);
  // Only inspect an existing subscription; never prompt for permission on page load.
  if(supported&&app.getCode())reg().then(function(r){return r.pushManager.getSubscription();}).then(async function(sub){if(sub){currentSub=sub;var saved=await request('status',{subscription:sub.toJSON()});if(saved.preferences)prefs=saved.preferences;indicator();}}).catch(function(){});
  return {disconnect:async function(code){
    if(!supported)return;
    var r=await reg(),sub=await r.pushManager.getSubscription();
    if(sub){try{await request('disable',{subscription:sub.toJSON()},code);}finally{await sub.unsubscribe();}}
    currentSub=null;prefs=defaults();indicator();
  }};
}};
})();
