use super::model::Completion;

pub fn xml(completion: &Completion) -> String {
    let title = if completion.title.is_empty() {
        "Your download is ready."
    } else {
        &completion.title
    };
    let escaped = title
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;");
    format!("<toast activationType=\"protocol\" launch=\"nabbit://downloads\"><visual><binding template=\"ToastGeneric\"><text>Download complete</text><text>{escaped}</text><text>Open Nabbit to see your downloads.</text></binding></visual><audio silent=\"true\"/></toast>")
}
#[cfg(windows)]
pub fn notification(
    xml: &str,
) -> windows::core::Result<windows::UI::Notifications::ToastNotification> {
    use windows::{
        core::HSTRING, Data::Xml::Dom::XmlDocument, UI::Notifications::ToastNotification,
    };
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(xml))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    toast.SetTag(&HSTRING::from("download-done"))?;
    toast.SetGroup(&HSTRING::from("nabbit"))?;
    Ok(toast)
}
pub fn show(app_id: &str, xml: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::{
            core::HSTRING,
            UI::Notifications::{NotificationSetting, ToastNotificationManager},
        };
        let _apartment = crate::tools::platform::Apartment::new().map_err(|e| e.to_string())?;
        let toast = notification(xml).map_err(|e| e.to_string())?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
            .map_err(|e| e.to_string())?;
        if notifier.Setting().map_err(|e| e.to_string())? != NotificationSetting::Enabled {
            return Err("Windows notifications are disabled for Nabbit".into());
        }
        notifier.Show(&toast).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app_id, xml);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completion_text_cannot_inject_xml_or_a_different_activation() {
        let xml = xml(&Completion {
            job_id: "owned".into(),
            title: "A <video> & \"title\" 'test'".into(),
        });
        assert!(xml.contains("A &lt;video&gt; &amp; &quot;title&quot; &apos;test&apos;"));
        assert_eq!(xml.matches("<toast ").count(), 1);
        assert!(xml.contains("launch=\"nabbit://downloads\""));
    }
    #[cfg(windows)]
    #[test]
    fn windows_parses_the_real_toast_without_showing_or_registering_it() {
        let _apartment = crate::tools::platform::Apartment::new().unwrap();
        let completion = Completion {
            job_id: "owned".into(),
            title: "A <video> & title".into(),
        };
        let toast = notification(&xml(&completion)).unwrap();
        let document = toast.Content().unwrap();
        assert!(document
            .InnerText()
            .unwrap()
            .to_string()
            .contains(&completion.title));
        assert_eq!(toast.Tag().unwrap().to_string(), "download-done");
        assert_eq!(toast.Group().unwrap().to_string(), "nabbit");
    }
}
